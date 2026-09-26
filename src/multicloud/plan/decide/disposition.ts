/**
 * Disposition and method per item: what happens to it (rehost, relocate,
 * retire ...) and how it moves (replicate, rebuild, relocate-hcx, managed-db).
 *
 * Explicit values win: the workload's own Disposition, then (after the
 * powered-off retire check) the app's Route. Otherwise the defaults of design
 * section 2.5 step 1 apply, in order. Two rules override even an explicit
 * value, because the alternative is a broken migration rather than a worse one:
 *
 *  - a domain controller is never replicated (USN rollback): it is rebuilt and
 *    promoted (`shape.dc-rebuild`);
 *  - nothing is left in the plan with a method its disposition cannot use.
 *
 * Pure, and imported by the rules at runtime, so it must not import the engine.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { isHyperscaler, type Platform } from '../../platforms.ts';
import { imageFor, isUnavailable } from '../images.ts';
import { supportStatus } from '../os.ts';
import type { App, Database, Disposition, Method, Requirements, Workload } from '../types.ts';

export type PlanItem = Workload | Database;

export function isDatabase(item: PlanItem): item is Database {
  return 'engine' in item;
}

/** Readiness checks (vm-readiness.ts ids) that replication cannot carry: the VM moves as a VM. */
export const RELOCATE_BLOCKERS: readonly string[] = ['rdm-physical', 'multi-writer', 'passthrough'];

/** The rule id recorded when a domain controller is forced to rebuild. */
export const DC_REBUILD = 'shape.dc-rebuild';
export const DC_SOURCE = 'https://learn.microsoft.com/windows-server/identity/ad-ds/get-started/virtual-dc/virtualized-domain-controllers-hyper-v';

export interface Placement {
  readonly disposition: Disposition;
  readonly method: Method;
  /** True when the workload or its app set the disposition. */
  readonly explicit: boolean;
  /** Why, in one line (the decision record prints it). */
  readonly why: string;
  readonly findings: readonly Finding[];
}

/** Route to method, as design section 2.5 step 1. */
export function methodFor(disposition: Disposition): Method {
  switch (disposition) {
    case 'rehost':
      return 'replicate';
    case 'relocate':
      return 'relocate-hcx';
    case 'replatform':
    case 'refactor':
      return 'rebuild';
    default:
      return 'none';
  }
}

export function hasRelocateBlocker(w: Workload): boolean {
  const f = w.facts;
  if (!f) return false;
  if (f.sharedDisks || f.passthrough) return true;
  return (f.readiness ?? []).some((r) => r.severity === 'blocker' && RELOCATE_BLOCKERS.includes(r.id));
}

export function isRetireCandidate(w: Workload): boolean {
  const f = w.facts;
  return !!f && f.powerState === 'poweredOff' && (f.readiness ?? []).some((r) => r.id === 'retire');
}

/** No image on any allowed hyperscaler, and past extended support on `today`. */
export function isUnimageableEol(w: Workload, requirements: Requirements, today: string): boolean {
  if (supportStatus(w.os, today) !== 'end-of-life') return false;
  const clouds = requirements.allowed.filter(isHyperscaler);
  if (clouds.length === 0) return false;
  return clouds.every((p: Platform) => isUnavailable(imageFor(w.os, p, { licence: w.licence })));
}

function place(disposition: Disposition, explicit: boolean, why: string, findings: Finding[] = [], method = methodFor(disposition)): Placement {
  return { disposition, method, explicit, why, findings };
}

/**
 * The workload's disposition and method before database coupling (the engine
 * turns a managed database's hosts into replatform / managed-db afterwards).
 */
export function workloadPlacement(w: Workload, app: App | undefined, requirements: Requirements, today: string): Placement {
  let p: Placement;
  if (w.disposition) p = place(w.disposition, true, `Set on the workload: ${w.disposition}.`);
  else if (isRetireCandidate(w)) p = place('retire', false, 'Powered off for more than 90 days: retire rather than migrate.');
  else if (app?.route) p = place(app.route, true, `The app ${app.name} is routed ${app.route}.`);
  else if (w.role === 'ad-dc') p = place('replatform', false, 'A domain controller is rebuilt and promoted, never replicated (USN rollback).');
  else if (hasRelocateBlocker(w)) p = place('relocate', false, 'Has a physical RDM, shared disk or passthrough device that replication cannot carry: it moves as a VM (HCX / vMotion).');
  else if (isUnimageableEol(w, requirements, today)) {
    p = place('rehost', false, 'No current image on any allowed cloud and past extended support: replicate it as it is.', [
      warning('plan.os.eol-replicate', `${w.name}: ${w.os} has no current image on any allowed cloud and is past extended support, so it is replicated as it is. Upgrade it after landing.`, {
        path: `workloads.${w.id}.os`,
        remediation: 'Plan the in-place upgrade (or rebuild) as the first change after cutover.',
      }),
    ]);
  } else if (w.role === 'appliance') p = place('relocate', false, 'An appliance moves as a VM: vendors support their image on vSphere, not a rebuild.');
  else p = place('rehost', false, 'Default: rehost by replication.');

  const findings = [...p.findings];
  let { disposition, method } = p;
  if (disposition === 'refactor') {
    findings.push(info('plan.refactor.out-of-scope', `${w.name}: refactor is out of scope for generated IaC beyond the landing zone.`, {
      path: `workloads.${w.id}.disposition`,
    }));
  }
  if (w.role === 'ad-dc' && method === 'replicate') {
    findings.push(warning('plan.dc.rebuild-forced', `${w.name} is a domain controller: rebuilt and promoted, not replicated, whatever its route says.`, {
      path: `workloads.${w.id}.disposition`,
      remediation: 'Build a new DC on the target, promote it, move the FSMO roles, then demote the old one.',
      source: DC_SOURCE,
    }));
    disposition = 'replatform';
    method = 'rebuild';
  }
  if (method === 'replicate' && hasRelocateBlocker(w)) {
    findings.push(warning('plan.blocker.replicate', `${w.name} has a move blocker (physical RDM, shared disk or passthrough) that replication cannot carry.`, {
      path: `workloads.${w.id}.disposition`,
      remediation: 'Relocate it as a VM (HCX), or remove the blocker before replicating.',
    }));
  }
  return { ...p, disposition, method, findings };
}

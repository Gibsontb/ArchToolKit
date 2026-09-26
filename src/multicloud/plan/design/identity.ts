/**
 * Identity: where the domain lives on each platform.
 *
 * - **extend-dcs**: two new domain controllers per hyperscaler, promoted into
 *   the existing forest by Ansible (never replicated: a restored DC is a USN
 *   rollback waiting to happen). They are `{prefix}-dc01/02`, Windows Server
 *   2025 Standard, 2 vCPU / 8 GiB, mgmt tier, in the prod network's first two
 *   zones, rebuilt from the image. When the plan already sends domain
 *   controllers (role ad-dc) to the platform, those are used instead, spread
 *   across zones.
 * - **managed-ad**: AWS Managed Microsoft AD, Microsoft Entra Domain Services,
 *   Managed Service for Microsoft AD. OCI has none, so it falls back to
 *   extend-dcs with a finding.
 * - VCF on owned hardware keeps using the existing domain controllers.
 *
 * The added DCs are not rows in the plan; `designWorkloads(plan, design)`
 * returns the plan's workloads plus them, for the generators.
 */

import { info, warning, type Finding } from '../../../core/findings.ts';
import { itemId } from '../options.ts';
import type { AdStrategy, Plan, Platform, PlatformDesign, TargetDesign, Workload } from '../types.ts';
import { computeTargetFor, networkOf, spreadAcrossZones } from './compute.ts';
import type { DesignContext, DesignMapper } from './index.ts';
import { networkZones } from './network.ts';

/** The strategy that applies on a platform (OCI has no managed AD). */
export function strategyFor(requested: AdStrategy, platform: Platform): AdStrategy {
  return requested === 'managed-ad' && platform === 'oci' ? 'extend-dcs' : requested;
}

/** The managed directory service per platform, for the card and the generators. */
export const MANAGED_AD: Readonly<Partial<Record<Platform, { readonly service: string; readonly resource: string }>>> = {
  aws: { service: 'AWS Managed Microsoft AD (Enterprise)', resource: 'aws_directory_service_directory' },
  azure: { service: 'Microsoft Entra Domain Services', resource: 'azurerm_active_directory_domain_service' },
  google: { service: 'Managed Service for Microsoft Active Directory', resource: 'google_active_directory_domain' },
};

/** The two domain controllers extend-dcs adds on a platform (not plan rows; ids are stable per prefix). */
export function dcWorkloads(plan: Plan, platform: Platform, prefix: string): Workload[] {
  const ahb = platform === 'azure' && plan.requirements.licensing.microsoftSa === 'yes-all';
  return ['dc01', 'dc02'].map((n) => {
    const name = `${prefix}-${n}`;
    return {
      id: itemId('workload', name),
      name,
      app: 'Active Directory',
      env: 'prod',
      role: 'ad-dc',
      os: 'win-2025',
      vcpu: 2,
      ramGib: 8,
      disksGib: [128],
      criticality: 'tier0',
      rpo: '15m',
      rto: '1h',
      licence: ahb ? 'byol-sa' : 'li',
      dependsOn: [],
      source: 'manual',
    } satisfies Workload;
  });
}

/** Does the design add DCs on this platform (rather than using the plan's own). */
function addsDcs(design: PlatformDesign): boolean {
  return design.identity.strategy === 'extend-dcs' && design.compute.some((c) => c.workload === itemId('workload', `${design.prefix}-dc01`));
}

/** The plan's workloads plus the domain controllers the design added, for the generators. */
export function designWorkloads(plan: Plan, design: TargetDesign): Workload[] {
  const added = design.platforms.filter(addsDcs).flatMap((pd) => dcWorkloads(plan, pd.platform, pd.prefix));
  const known = new Set(plan.workloads.map((w) => w.id));
  return [...plan.workloads, ...added.filter((w) => !known.has(w.id))];
}

export const identityMapper: DesignMapper = {
  id: 'identity',
  map(ctx: DesignContext, design) {
    const findings: Finding[] = [];
    const { plan, platform } = ctx;
    const req = plan.requirements.identity;
    const strategy = strategyFor(req.adStrategy, platform);
    if (req.adStrategy === 'managed-ad' && platform === 'oci') {
      findings.push(warning('design.identity.oci-no-managed-ad', 'OCI has no managed Microsoft AD: two domain controllers are built there instead (extend-dcs).', {
        remediation: 'Nothing to do; or place OCI\'s Windows workloads where a managed directory exists.',
      }));
    }
    if (strategy !== 'none' && !req.domain?.trim()) {
      findings.push(warning('design.identity.no-domain', 'No AD domain is set: the directory and domain join need its FQDN.', { path: 'requirements.identity.domain' }));
    }

    const existing = design.compute.filter((c) => ctx.workloads.some((w) => w.id === c.workload && w.role === 'ad-dc'));
    if (strategy !== 'extend-dcs' || platform === 'vmware') {
      if (platform === 'vmware' && strategy !== 'none') {
        findings.push(info('design.identity.vmware-existing', 'VCF on owned hardware uses the existing domain controllers: none are added.'));
      }
      const dcNames = existing.map((c) => ctx.workloads.find((w) => w.id === c.workload)!.name);
      return { design: { ...design, identity: { strategy, dcNames } }, findings };
    }

    if (existing.length > 0) {
      const names = existing.map((c) => ctx.workloads.find((w) => w.id === c.workload)!.name);
      if (existing.length === 1) {
        findings.push(warning('design.identity.one-dc', `${platform} gets one domain controller from the plan (${names[0]}); a second, in another zone, keeps sign-in working through a zone outage.`));
      }
      const spread = spreadAcrossZones(design, existing.map((c) => c.workload), `${platform} domain controllers`);
      findings.push(...spread.findings);
      return { design: { ...design, compute: spread.compute, identity: { strategy, dcNames: names } }, findings };
    }

    const network = networkOf(design, 'prod');
    if (!network) {
      findings.push(warning('design.identity.no-network', `${platform} has no network for its domain controllers.`));
      return { design: { ...design, identity: { strategy, dcNames: [] } }, findings };
    }
    const zones = networkZones(network);
    if (zones.length < 2) {
      findings.push(info('design.compute.ha-single-zone', `${platform}: the prod network has one zone, so both domain controllers share it.`));
    }
    const dcs = dcWorkloads(plan, platform, design.prefix);
    const added = dcs.map((w, i) => {
      const r = computeTargetFor(ctx, w, { network, zone: zones[i % Math.max(1, zones.length)] ?? '' });
      findings.push(...r.findings);
      return r.target;
    });
    return {
      design: { ...design, compute: [...design.compute, ...added], identity: { strategy, dcNames: dcs.map((w) => w.name) } },
      findings,
    };
  },
};

/**
 * The Constraints pane's model side, with no DOM: the checks the constraint
 * cards show, the landing-zone mode across the application plans, and the
 * region choices per platform.
 */

import { error, info, warning,              } from '../../core/findings.js';
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, OCI_REGIONS } from '../../kit/regions.js';
import { AGREEMENT_PLATFORM, PLATFORM_LABELS, defaultConnection } from '../../multicloud/plan/options.js';
                                                                                                    
import { siteProblems } from './grid-model.js';

/** A platform's region list; VMware's "region" is the vCenter, typed. */
export const REGION_LISTS                                                         = {
  aws: AWS_REGIONS,
  azure: AZURE_REGIONS,
  google: GCP_REGIONS,
  oci: OCI_REGIONS,
};

/** The dropdown's choices: the list, plus the current value when it is not in it (nothing is lost). */
export function regionChoices(platform          , current                    , blank         )                                     {
  const list = REGION_LISTS[platform] ?? [];
  const out = list.map((r) => ({ value: r, label: r }));
  if (current && !list.includes(current)) out.unshift({ value: current, label: `${current} (as typed)` });
  if (blank !== undefined) out.unshift({ value: '', label: blank });
  return out;
}

/** Government regions by their providers' naming. */
const GOV_REGION = /^(us-gov-|usgov|usdod|us-dod|us-langley|us-luke|us-gov)/i;

/** The checks the constraint cards show (the decision raises its own when it runs). */
export function constraintFindings(plan      )            {
  const r = plan.requirements;
  const out            = [];
  if (r.allowed.length === 0) {
    out.push(error('constraints.no-platform', 'No platform is allowed, so nothing can be placed.', { remediation: 'Tick at least one platform on the Platforms card.' }));
  } else if (r.maxPlatforms > r.allowed.length) {
    out.push(info('constraints.max-over-allowed', `At most ${r.maxPlatforms} platforms, but only ${r.allowed.length} ${r.allowed.length === 1 ? 'is' : 'are'} allowed; the smaller number applies.`));
  }
  for (const p of r.allowed) {
    const region = r.regions[p];
    if (!region?.primary?.trim()) {
      // A fresh plan allows VCF with no vCenter yet: a reminder, not a problem.
      const msg = `${PLATFORM_LABELS[p]} is allowed but has no ${p === 'vmware' ? 'vCenter' : 'primary region'}.`;
      out.push(p === 'vmware' ? info('constraints.region-missing', msg, { remediation: 'Type the target vCenter’s FQDN on the Platforms card.' }) : warning('constraints.region-missing', msg));
    }
    else if (region.dr && region.dr === region.primary) out.push(warning('constraints.dr-same-region', `${PLATFORM_LABELS[p]}: the DR region is the primary region, so a regional outage takes both.`));
  }
  if (r.sovereignty === 'government-region') {
    const commercial = r.allowed.filter((p) => p !== 'vmware' && r.regions[p]?.primary && !GOV_REGION.test(r.regions[p] .primary));
    if (commercial.length > 0) {
      out.push(warning('constraints.sovereignty-region', `Sovereignty requires government regions; the region chosen for ${commercial.map((p) => PLATFORM_LABELS[p]).join(', ')} is commercial.`, {
        remediation: 'Pick the provider’s government region (GovCloud, Azure Government, Assured Workloads, OCI US Government).',
      }));
    }
  }
  if (!Number.isFinite(r.timelineMonths) || r.timelineMonths <= 0) out.push(error('constraints.timeline', 'The timeline must be a number of months greater than 0.'));
  const late = plan.apps.filter((a) => a.deadlineMonths !== undefined && a.deadlineMonths > r.timelineMonths);
  if (late.length > 0) out.push(warning('constraints.app-deadline', `${late.length} application(s) have a deadline after the programme’s ${r.timelineMonths} months: ${late.slice(0, 5).map((a) => a.name).join(', ')}.`));
  for (const c of r.commitments) {
    if (!r.allowed.includes(c.platform)) out.push(warning('constraints.commitment-excluded', `A ${c.agreement} commitment is on ${PLATFORM_LABELS[c.platform]}, which is not allowed.`));
    if (AGREEMENT_PLATFORM[c.agreement] !== c.platform && c.agreement !== 'enterprise-agreement') {
      out.push(warning('constraints.commitment-platform', `The ${c.agreement} agreement belongs to ${PLATFORM_LABELS[AGREEMENT_PLATFORM[c.agreement]]}, not ${PLATFORM_LABELS[c.platform]}.`));
    }
  }
  if (r.licensing.oracle !== 'none' && !plan.databases.some((d) => d.engine === 'oracle')) {
    out.push(info('constraints.oracle-unused', 'Oracle licences are recorded but the plan has no Oracle database.'));
  }
  const tiers = new Set(r.backupTiers.map((t) => t.tier));
  for (const t of ['gold', 'silver', 'bronze']         ) if (!tiers.has(t)) out.push(warning('constraints.backup-tier-missing', `No ${t} backup tier; the servers mapped to it get none.`));
  return out;
}

/** The connectivity card's checks: addresses of either family, and the connection. */
export function connectivityFindings(r              )            {
  const out            = siteProblems(r.sites).map((m) => warning('constraints.site', m));
  const suggested = defaultConnection(r.sites);
  if (r.connection !== 'vpn' && !r.sites.some((s) => s.circuit !== 'none')) {
    out.push(warning('constraints.connection-no-circuit', 'The connection uses a private circuit, but no site has one.'));
  } else if (r.connection !== suggested && suggested === 'circuit-with-vpn-backup') {
    out.push(info('constraints.connection-suggested', 'A site has a private circuit: circuit with VPN backup is the usual choice.'));
  }
  const noV6 = r.sites.filter((s) => s.cidrs.length > 0 && !s.cidrs.some((c) => c.includes(':')));
  if (noV6.length > 0 && r.sites.length > 0) out.push(info('constraints.site-ipv4-only', `${noV6.length} site(s) list only IPv4 ranges; add their IPv6 prefixes so the landing zones route both families.`));
  return out;
}

                                                                  

/** The landing-zone mode the application plans share, 'mixed' when they differ, 'none' with no plans. */
export function landingZoneState(plan      )                   {
  const modes = new Set((plan.appPlans ?? []).map((a) => a.landingZone));
  if (modes.size === 0) return 'none';
  return modes.size === 1 ? ([...modes][0]                   ) : 'mixed';
}

/** Every application plan set to one landing-zone mode. */
export function setLandingZone(plan      , mode                 )       {
  return { ...plan, appPlans: (plan.appPlans ?? []).map((a) => (a.landingZone === mode ? a : { ...a, landingZone: mode })) };
}

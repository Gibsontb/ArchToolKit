/**
 * Backup: the requirement's tiers (gold / silver / bronze), each mapped to the
 * platform's own policy, and every compute and database target carrying a
 * tier (from criticality: tier0/1 gold, tier2 silver, tier3 bronze) that the
 * generators write as the `atk_backup` tag the policies select on.
 *
 * - aws: AWS Backup plan rule per tier (cron), vault lock for immutable tiers,
 *   copy to the DR region's vault.
 * - azure: Recovery Services vault policy per tier; hourly schedules are
 *   Enhanced (V2) policies, whose interval is 4, 6, 8 or 12 hours, so 1h is
 *   raised to 4h with a finding.
 * - google: Backup and DR backup plan per tier.
 * - oci: volume backup policy per tier.
 * - vmware: the existing backup product; the tag is still written.
 */

import { info, warning,              } from '../../../core/findings.js';
import { DEFAULT_BACKUP_TIERS } from '../options.js';
                                                                                       
                                               

                                 
                                                                                                                                                
                            
                                                    
                                    
                                                                 
                             
 

const HOURS                                            = { '1h': 1, '4h': 4, '12h': 12, '24h': 24 };

/** A tier's schedule on a platform (verify the Google and OCI minimum intervals). */
export function backupSchedule(platform          , frequency                 )                 {
  const h = HOURS[frequency];
  switch (platform) {
    case 'aws':
      return { schedule: h === 24 ? 'cron(0 3 * * ? *)' : h === 1 ? 'cron(0 * * * ? *)' : `cron(0 */${h} * * ? *)` };
    case 'azure':
      if (h === 24) return { schedule: 'Daily', policyType: 'V1' };
      return h < 4
        ? { schedule: 'Hourly:4', policyType: 'V2', adjusted: 'Azure Enhanced policies back up every 4, 6, 8 or 12 hours at most; 1h becomes 4h.' }
        : { schedule: `Hourly:${h}`, policyType: 'V2' };
    case 'google':
      return { schedule: h === 24 ? 'DAILY' : `HOURLY:${h}` };
    case 'oci':
      return h === 24 ? { schedule: 'ONE_DAY' } : { schedule: 'ONE_HOUR', ...(h > 1 ? { adjusted: `OCI volume backup schedules run hourly or daily; ${frequency} runs hourly.` } : {}) };
    default:
      return { schedule: `every ${frequency}` };
  }
}

export const backupMapper               = {
  id: 'backup',
  map(ctx, design) {
    const findings            = [];
    const { platform } = ctx;
    const tiers               = ctx.plan.requirements.backupTiers.map((t) => ({ ...t }));
    const used = new Set              ([...design.compute.map((c) => c.backupTier), ...design.databases.map((d) => d.backupTier)]);
    for (const id of used) {
      if (!tiers.some((t) => t.tier === id)) {
        const fallback = DEFAULT_BACKUP_TIERS.find((t) => t.tier === id) ;
        tiers.push({ ...fallback });
        findings.push(warning('design.backup.missing-tier', `${platform}: targets use the ${id} backup tier, which the requirements do not define; the default (${fallback.frequency}, ${fallback.retentionDays} days) is used.`, {
          path: 'requirements.backupTiers',
        }));
      }
    }
    for (const t of tiers) {
      const s = backupSchedule(platform, t.frequency);
      if (s.adjusted && used.has(t.tier)) findings.push(info('design.backup.adjusted', `${platform} ${t.tier}: ${s.adjusted}`));
      if (t.copyToDr && !design.drRegion && used.has(t.tier) && platform !== 'vmware') {
        findings.push(warning('design.backup.no-dr-region', `${platform} ${t.tier}: copies to a DR region, but no DR region is set, so backups stay in ${design.region}.`, {
          path: `requirements.regions.${platform}.dr`,
        }));
      }
    }
    if (platform === 'vmware' && used.size > 0) {
      findings.push(info('design.backup.vmware', 'VCF on owned hardware: use the existing backup product; each VM carries its atk_backup tag for its policy.'));
    }
    const order                 = ['gold', 'silver', 'bronze'];
    tiers.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
    return { design: { ...design, backup: { tiers } }, findings };
  },
};

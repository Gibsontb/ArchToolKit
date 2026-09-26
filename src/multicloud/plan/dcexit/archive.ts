/**
 * The retention obligation register (addendum A.5.5, Storage & data).
 *
 * Every archive with a retention date or a legal hold becomes a row with its
 * own obligation:
 *   - `migrate-to-archive-tier`: into the target's archive storage (S3 Glacier
 *     Deep Archive, Azure Blob archive tier, Google Cloud Archive storage, OCI
 *     Archive Storage), by the transfer tools;
 *   - `keep-until-expiry`: held at a third party until the retention ends;
 *   - `restore-and-migrate`: restored from the old media and moved as data.
 *
 * An archive under legal hold cannot be retired (`dc.legal-hold`), and one
 * whose retention has not expired should not be (`dc.retention`).
 *
 * Archive facts (InfraItem `category: 'archive'`): `media` (tape,
 * disk-archive, optical), `location`, `content`, `retentionUntil` (ISO date),
 * `legalHold` (yes / no) and `obligation` (one of the three above).
 */

import { error, warning, type Finding } from '../../../core/findings.ts';
import type { InfraItem, Platform } from '../types.ts';

export type ArchiveMedia = 'tape' | 'disk-archive' | 'optical';
export const ARCHIVE_MEDIA: readonly ArchiveMedia[] = ['tape', 'disk-archive', 'optical'];
export type RetentionObligation = 'migrate-to-archive-tier' | 'keep-until-expiry' | 'restore-and-migrate';
export const RETENTION_OBLIGATIONS: readonly RetentionObligation[] = ['migrate-to-archive-tier', 'keep-until-expiry', 'restore-and-migrate'];

/** The archive storage each platform offers (a storage class or tier, not a separate service). */
export const ARCHIVE_TIERS: Readonly<Record<Platform, { readonly name: string; readonly terraform: string; readonly setting: string } | { readonly none: string }>> = {
  aws: { name: 'S3 Glacier Deep Archive', terraform: 'aws_s3_bucket_lifecycle_configuration', setting: 'transition.storage_class = "DEEP_ARCHIVE"' },
  azure: { name: 'Azure Blob Storage archive tier', terraform: 'azurerm_storage_management_policy', setting: 'tier_to_archive_after_days_since_modification_greater_than' },
  google: { name: 'Archive storage class', terraform: 'google_storage_bucket', setting: 'storage_class = "ARCHIVE"' },
  oci: { name: 'OCI Archive Storage', terraform: 'oci_objectstorage_bucket', setting: 'storage_tier = "Archive"' },
  vmware: { none: 'VCF has no archive tier: keep the archive with a third party or on one of the clouds.' },
};

export interface RetentionRow {
  readonly id: string;
  readonly name: string;
  readonly media: string;
  readonly location: string;
  readonly content: string;
  readonly retentionUntil?: string;
  readonly legalHold: boolean;
  readonly owner?: string;
  readonly disposition?: InfraItem['disposition'];
  readonly obligation?: RetentionObligation;
  /** Retention has passed and there is no hold: the archive may be retired. */
  readonly expired: boolean;
}

const yes = (v: string | undefined): boolean => /^(yes|y|true|1)$/i.test((v ?? '').trim());

/** Archives with a retention date or a legal hold, one row each. */
export function retentionRegister(items: readonly InfraItem[], today: string): RetentionRow[] {
  const rows: RetentionRow[] = [];
  for (const item of items) {
    if (item.category !== 'archive') continue;
    const retentionUntil = item.facts.retentionUntil?.trim() || undefined;
    const legalHold = yes(item.facts.legalHold);
    if (!retentionUntil && !legalHold) continue;
    const obligation = RETENTION_OBLIGATIONS.find((o) => o === item.facts.obligation);
    rows.push({
      id: item.id,
      name: item.name,
      media: item.facts.media ?? '',
      location: item.facts.location ?? item.site ?? '',
      content: item.facts.content ?? '',
      ...(retentionUntil ? { retentionUntil } : {}),
      legalHold,
      ...(item.owner ? { owner: item.owner } : {}),
      ...(item.disposition ? { disposition: item.disposition } : {}),
      ...(obligation ? { obligation } : {}),
      expired: !legalHold && !!retentionUntil && retentionUntil < today,
    });
  }
  return rows;
}

/** The register's rules: no retiring under hold, no retiring before expiry, every row has an obligation. */
export function checkArchives(items: readonly InfraItem[], today: string): Finding[] {
  const findings: Finding[] = [];
  for (const row of retentionRegister(items, today)) {
    if (row.legalHold && row.disposition === 'retire') {
      findings.push(
        error('dc.legal-hold', `Archive ${row.name} is under legal hold and cannot be retired.`, {
          path: `infra.${row.id}`,
          remediation: 'Choose migrate-to-archive-tier, keep-until-expiry or restore-and-migrate, and keep it until legal releases the hold.',
        }),
      );
    } else if (row.disposition === 'retire' && !row.expired) {
      findings.push(warning('dc.retention', `Archive ${row.name} is retained until ${row.retentionUntil}; retiring it before then breaks the retention obligation.`, { path: `infra.${row.id}` }));
    }
    if (!row.obligation && row.disposition !== 'retire') {
      findings.push(warning('dc.retention-obligation', `Archive ${row.name} has a retention obligation but no plan for it (migrate to an archive tier, keep until expiry, or restore and migrate).`, { path: `infra.${row.id}` }));
    }
  }
  return findings;
}

/** Is a disposition allowed for this archive: the dropdown uses it to refuse `retire` under hold. */
export function allowedArchiveDisposition(item: InfraItem, disposition: NonNullable<InfraItem['disposition']>): boolean {
  return !(item.category === 'archive' && yes(item.facts.legalHold) && disposition === 'retire');
}

/** Archives that are dispositioned: a disposition, and an obligation where the register has a row. */
export function archivesDispositioned(items: readonly InfraItem[], today: string): { readonly done: boolean; readonly open: readonly string[] } {
  const register = new Map(retentionRegister(items, today).map((r) => [r.id, r]));
  const open = items
    .filter((i) => i.category === 'archive')
    .filter((i) => {
      if (!i.disposition) return true;
      const row = register.get(i.id);
      if (!row) return false;
      if (row.legalHold && i.disposition === 'retire') return true;
      return !row.obligation && i.disposition !== 'retire';
    })
    .map((i) => i.name);
  return { done: open.length === 0, open };
}

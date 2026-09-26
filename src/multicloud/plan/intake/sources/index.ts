/**
 * Intake per source (addendum A.3.2): the discovery file every collector
 * writes, the provider import formats (tier 1: Azure Migrate CSV, Google
 * Migration Center tables, the AWS Migration Hub template, the Azure Migrate
 * dependency export; tier 2: the MGN import sheet and the Cloud Migration
 * Factory intake form), the Prism Central export, performance time series,
 * the collectors themselves and the A.3.6 sizing basis. Every table is read
 * by column header, never by position (`table.ts`).
 *
 * RVTools and the PowerCLI collector stay with the estate store (`VMWARE_ADAPTER`).
 */
export * from './table.ts';
export * from './common.ts';
export * from './sizing-basis.ts';
export * from './discovery.ts';
export * from './azure-migrate-csv.ts';
export * from './migration-center-csv.ts';
export * from './aws-import-csv.ts';
export * from './ahv-csv.ts';
export * from './perf-csv.ts';
export * from './azure-dependency-csv.ts';
export * from './tier2.ts';
export * from './collectors.ts';

import type { IntakeAdapter } from '../adapter.ts';
import { AHV_CSV_ADAPTER } from './ahv-csv.ts';
import { AWS_IMPORT_CSV_ADAPTER } from './aws-import-csv.ts';
import { AZURE_MIGRATE_CSV_ADAPTER } from './azure-migrate-csv.ts';
import { DISCOVERY_ADAPTER } from './discovery.ts';
import { MIGRATION_CENTER_CSV_ADAPTER } from './migration-center-csv.ts';
import { CMF_INTAKE_CSV_ADAPTER, MGN_IMPORT_CSV_ADAPTER } from './tier2.ts';

/** The source adapters, in the order the Sources screen offers them after the VMware estate and the CSV grids. */
export const SOURCE_INTAKE_ADAPTERS: readonly IntakeAdapter<never, never>[] = Object.freeze([
  DISCOVERY_ADAPTER as unknown as IntakeAdapter<never, never>,
  AZURE_MIGRATE_CSV_ADAPTER as unknown as IntakeAdapter<never, never>,
  MIGRATION_CENTER_CSV_ADAPTER as unknown as IntakeAdapter<never, never>,
  AWS_IMPORT_CSV_ADAPTER as unknown as IntakeAdapter<never, never>,
  AHV_CSV_ADAPTER as unknown as IntakeAdapter<never, never>,
  MGN_IMPORT_CSV_ADAPTER as unknown as IntakeAdapter<never, never>,
  CMF_INTAKE_CSV_ADAPTER as unknown as IntakeAdapter<never, never>,
]);

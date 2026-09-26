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
export * from './table.js';
export * from './common.js';
export * from './sizing-basis.js';
export * from './discovery.js';
export * from './azure-migrate-csv.js';
export * from './migration-center-csv.js';
export * from './aws-import-csv.js';
export * from './ahv-csv.js';
export * from './perf-csv.js';
export * from './azure-dependency-csv.js';
export * from './tier2.js';
export * from './collectors.js';

                                                   
import { AHV_CSV_ADAPTER } from './ahv-csv.js';
import { AWS_IMPORT_CSV_ADAPTER } from './aws-import-csv.js';
import { AZURE_MIGRATE_CSV_ADAPTER } from './azure-migrate-csv.js';
import { DISCOVERY_ADAPTER } from './discovery.js';
import { MIGRATION_CENTER_CSV_ADAPTER } from './migration-center-csv.js';
import { CMF_INTAKE_CSV_ADAPTER, MGN_IMPORT_CSV_ADAPTER } from './tier2.js';

/** The source adapters, in the order the Sources screen offers them after the VMware estate and the CSV grids. */
export const SOURCE_INTAKE_ADAPTERS                                         = Object.freeze([
  DISCOVERY_ADAPTER                                          ,
  AZURE_MIGRATE_CSV_ADAPTER                                          ,
  MIGRATION_CENTER_CSV_ADAPTER                                          ,
  AWS_IMPORT_CSV_ADAPTER                                          ,
  AHV_CSV_ADAPTER                                          ,
  MGN_IMPORT_CSV_ADAPTER                                          ,
  CMF_INTAKE_CSV_ADAPTER                                          ,
]);

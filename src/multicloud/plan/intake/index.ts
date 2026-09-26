/**
 * Intake: the Sources, Workloads, Databases and Apps screens' model side.
 * Sources are adapters (`adapter.ts`); add a new one (a physical-server
 * list, Hyper-V, Nutanix, KVM) in its own file and list it here.
 */

import type { IntakeAdapter } from './adapter.ts';
import { CSV_ADAPTER } from './csv.ts';
import { PORTFOLIO_ADAPTER } from './from-portfolio.ts';
import { VMWARE_ADAPTER } from './from-inventory.ts';
import { SOURCE_INTAKE_ADAPTERS } from './sources/index.ts';

export * from './adapter.ts';
export * from './from-inventory.ts';
export * from './from-portfolio.ts';
export * from './csv.ts';
export * from './merge.ts';
export * from './validate.ts';
export * from './grouping.ts';

/** Every intake source, in the order the Sources screen offers them. */
export const INTAKE_ADAPTERS: readonly IntakeAdapter<never, never>[] = Object.freeze([
  VMWARE_ADAPTER as unknown as IntakeAdapter<never, never>,
  CSV_ADAPTER as unknown as IntakeAdapter<never, never>,
  PORTFOLIO_ADAPTER as unknown as IntakeAdapter<never, never>,
  // WP-15: collector files and provider import formats (intake/sources/).
  ...SOURCE_INTAKE_ADAPTERS,
]);

/** An adapter by id. */
export function intakeAdapter(id: string): IntakeAdapter<never, never> | undefined {
  return INTAKE_ADAPTERS.find((a) => a.id === id);
}

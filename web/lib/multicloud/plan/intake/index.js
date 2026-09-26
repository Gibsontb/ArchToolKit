/**
 * Intake: the Sources, Workloads, Databases and Apps screens' model side.
 * Sources are adapters (`adapter.ts`); add a new one (a physical-server
 * list, Hyper-V, Nutanix, KVM) in its own file and list it here.
 */

                                                  
import { CSV_ADAPTER } from './csv.js';
import { PORTFOLIO_ADAPTER } from './from-portfolio.js';
import { VMWARE_ADAPTER } from './from-inventory.js';

export * from './adapter.js';
export * from './from-inventory.js';
export * from './from-portfolio.js';
export * from './csv.js';
export * from './merge.js';
export * from './validate.js';

/** Every intake source, in the order the Sources screen offers them. */
export const INTAKE_ADAPTERS                                         = Object.freeze([
  VMWARE_ADAPTER                                          ,
  CSV_ADAPTER                                          ,
  PORTFOLIO_ADAPTER                                          ,
]);

/** An adapter by id. */
export function intakeAdapter(id        )                                          {
  return INTAKE_ADAPTERS.find((a) => a.id === id);
}

/**
 * What is known about an application, and what the evaluation makes of it.
 *
 * One shape, used by the intake form, the portfolio, the CSV import and the
 * exported record, so an application evaluated last month reads the same as
 * one evaluated today.
 */

import type { Cloud, Criticality } from './options.ts';
import type { Recommendation } from './services.ts';

export interface Ratings {
  /** Every factor reads the same way: 5 is the best case for a move. */
  readonly cloudCompatibility: number;
  /** 5 = little technical debt. */
  readonly technicalDebt: number;
  /** 5 = little vendor lock-in. */
  readonly vendorLockRisk: number;
  /** 5 = compliance is simple here. */
  readonly complianceComplexity: number;
  readonly architectureModularity: number;
  /** 5 = little refactoring needed. */
  readonly refactorEffort: number;
}

export interface Gates {
  readonly isObsolete: boolean;
  readonly vendorSaaSAvailable: boolean;
  readonly mustStayOnPrem: boolean;
  readonly hardwareBound: boolean;
  readonly mainframeBound: boolean;
  readonly dataSovereigntyRequired: boolean;
}

export interface Application {
  readonly name: string;
  readonly owner: string;
  readonly criticality: Criticality;
  readonly rtoHours: number;
  readonly rpoHours: number;
  readonly workloadType: string;
  /** The cloud the enterprise has standardised on, when it has. */
  readonly enterpriseStandardCloud: Cloud | '';
  readonly primaryStack: string;
  readonly osRuntime: string;
  readonly database: string;
  readonly hostingPlatform: string;
  readonly integrationTypes: string;
  readonly architecturePattern: string;
  readonly vendor: string;
  readonly integrationCount: number;
  readonly dataSizeGb: number;
  readonly identity: string;
  readonly notes: string;
  readonly compliance: readonly string[];
  readonly gates: Gates;
  readonly ratings: Ratings;
}

export type Route = 'Rehost' | 'Replatform' | 'Refactor' | 'Repurchase' | 'Retain' | 'Retire';
export type Risk = 'Low' | 'Medium' | 'High';

export interface Evaluation {
  readonly readiness: number;
  readonly route: Route;
  readonly rationale: string;
  readonly cloud: Cloud;
  readonly cloudRationale: string;
  readonly risk: Risk;
  /** What put it in that risk band, in the user's own answers. */
  readonly riskBecause: readonly string[];
  readonly plan: readonly string[];
  /** What to use on the chosen cloud, capability by capability. */
  readonly services: readonly Recommendation[];
}

export interface PortfolioEntry {
  readonly id: string;
  readonly application: Application;
  readonly evaluation: Evaluation;
  readonly evaluatedAt: string;
  /** From a CSV import rather than a full evaluation: the ratings are defaults. */
  readonly draft: boolean;
}

export const DEFAULT_RATINGS: Ratings = {
  cloudCompatibility: 3,
  technicalDebt: 3,
  vendorLockRisk: 3,
  complianceComplexity: 3,
  architectureModularity: 3,
  refactorEffort: 3,
};

export const NO_GATES: Gates = {
  isObsolete: false,
  vendorSaaSAvailable: false,
  mustStayOnPrem: false,
  hardwareBound: false,
  mainframeBound: false,
  dataSovereigntyRequired: false,
};

export const EMPTY_APPLICATION: Application = {
  name: '',
  owner: '',
  criticality: 'High',
  rtoHours: 24,
  rpoHours: 4,
  workloadType: 'General LOB App',
  enterpriseStandardCloud: '',
  primaryStack: '',
  osRuntime: '',
  database: '',
  hostingPlatform: '',
  integrationTypes: '',
  architecturePattern: '',
  vendor: '',
  integrationCount: 5,
  dataSizeGb: 200,
  identity: '',
  notes: '',
  compliance: [],
  gates: NO_GATES,
  ratings: DEFAULT_RATINGS,
};

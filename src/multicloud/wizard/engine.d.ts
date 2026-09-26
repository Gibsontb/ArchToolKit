/**
 * The typed boundary around the wizard's engine.
 *
 * engine.js is the previous toolkit's JavaScript, corrected and extended (the
 * 2026 service names, VMware Cloud Foundation 9.1 as a fifth cloud, a pure
 * state builder). Everything that calls into it is checked against these
 * signatures, so the untyped region stops at this file.
 */

/** The cloud the wizard is designing for: azure | aws | gcp | oci | vcf. */
export type WizardCloudId = 'azure' | 'aws' | 'gcp' | 'oci' | 'vcf';

/** The answers as the engine reads them: field id to value, a list for a checkbox group. */
export type WizardAnswers = Readonly<Record<string, string | readonly string[]>>;

/** The engine's state: every answer, typed as the engine reads it. */
export interface WizardState {
  readonly initiativeType: string;
  readonly newServiceType: string;
  readonly newServiceStage: string;
  readonly existingChangeType: string;
  readonly existingPainPoints: string;
  readonly maintenanceFocus: string;
  readonly maintenanceCadence: string;
  readonly migrationScope: string;
  readonly cutoverStrategy: string;
  readonly workloadName: string;
  readonly appPattern: string;
  readonly architectureType: string;
  readonly trafficPattern: string;
  readonly latencySensitivity: string;
  readonly teamSkills: readonly string[];
  readonly description: string;
  readonly dataType: string;
  readonly dataSensitivity: string;
  readonly writePattern: string;
  readonly geoPattern: string;
  readonly integrations: string;
  readonly complianceNotes: string;
  readonly criticality: string;
  readonly uptimeTarget: string;
  readonly rto: string;
  readonly rpo: string;
  readonly timeToMarket: string;
  readonly opsMaturity: string;
  readonly securityBaseline: string;
  readonly identityModel: string;
  readonly secretsModel: string;
  readonly dataProtection: string;
  readonly perimeterPattern: string;
  readonly f5Usage: readonly string[];
  readonly secOpsMaturity: string;
  readonly sourceEnv: string;
  readonly migrationApproach: string;
  readonly dbStrategy: string;
  readonly iaCTools: readonly string[];
  readonly peakUsers: number;
  readonly peakRps: number;
  readonly dataVolumeBand: string;
  readonly dailyIngestBand: string;
  readonly retentionPeriod: string;
  readonly envScope: readonly string[];
  readonly nonProdScale: string;
  readonly regionCount: string;
  readonly onPremLink: string;
  readonly crossCloud: string;
}

/** Every section of the recommendation, as HTML, keyed by the id of the element it goes in. */
export interface RecommendationSections {
  readonly computeMain: string;
  readonly computeNotes: string;
  readonly dataMain: string;
  readonly dataNotes: string;
  readonly integrationMain: string;
  readonly integrationNotes: string;
  readonly opsMain: string;
  readonly opsNotes: string;
  readonly securityMain: string;
  readonly securityNotes: string;
  readonly controlsMain: string;
  readonly migrationMain: string;
  readonly migrationNotes: string;
  readonly drPatternMain: string;
  readonly sizingMain: string;
  readonly sizingNotes: string;
  readonly sizingMatrix: string;
  readonly howToMain: string;
  readonly assumptionsMain: string;
  readonly pills: readonly string[];
}

export declare let currentCloud: string;
export declare function setCurrentCloud(cloud: string): void;

/** The step showing. The validator reads it. */
export declare let currentStep: number;
export declare function setCurrentStep(step: number): void;

/** The provider's display name ("Azure", "AWS", "Google Cloud", "Oracle Cloud Infrastructure", "VMware Cloud Foundation (VCF 9.1)"). */
export declare function providerNameOf(cloud: string): string;

/** True always (soft validation); writes what is missing under the step. */
export declare function validateStep(step: number): boolean;

/** Clears the error line under every step. */
export declare function clearErrors(): void;

/** The answer pills. */
export declare function buildSummaryPills(state: WizardState): string[];

/** The answers read from the page's `[data-wizard-field]` controls. */
export declare function readWizardAnswers(): Record<string, string | string[]>;

/** The engine's state from plain answers. Pure. */
export declare function stateFromAnswers(answers: WizardAnswers): WizardState;

/** Every section for a cloud. Pure. */
export declare function recommendationSections(cloud: string, state: WizardState): RecommendationSections;

/** Builds the recommendation into the page (from the page's answers unless a state is given); returns the state used. */
export declare function generateRecommendation(state?: WizardState): WizardState;

/** The recommendation as a standalone HTML document, for export and print. */
export declare function buildRecommendationDocumentHtml(): string;

/** Opens the recommendation full screen in its own window. */
export declare function openFullViewWindow(): void;

/** Opens the print dialog on the recommendation. */
export declare function openPrintView(): void;

/** Downloads the recommendation as a Word document. */
export declare function exportRecommendationAsWord(): void;

export declare function buildSizingPlan(cloud: string, state: WizardState): { main: string; notes: string; matrixHtml: string };
export declare function buildDrPatternCard(state: WizardState, cloud: string): string;
export declare function buildCyberChecklist(state: WizardState, cloud: string): string;
export declare function buildAssumptionsAndGaps(state: WizardState, cloud: string): string;
export declare function buildHowToPlaybook(cloud: string, state: WizardState): string;
export declare function generateCloudRecommendation(cloud: string, state: WizardState): {
  computeMain: string; computeNotes: string; dataMain: string; dataNotes: string; integMain: string; integNotes: string;
  opsMain: string; opsNotes: string; migrationMain: string; migrationNotes: string; securityMain: string; securityNotes: string;
};
export declare function getMultiSelectValues(select: unknown): string[];
export declare function getCheckedValues(name: string): string[];

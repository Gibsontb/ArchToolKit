/**
 * The typed boundary around the ported engine.
 *
 * engine.js is the original JavaScript, kept verbatim. Everything that calls
 * into it is checked against these signatures, so the untyped region stops at
 * this file rather than leaking into the page.
 */

/** The cloud the wizard is designing for: azure | aws | gcp | oci. */
export declare let currentCloud: string;
export declare function setCurrentCloud(cloud: string): void;

/** The step showing, 1-4. The validator reads it. */
export declare let currentStep: number;
export declare function setCurrentStep(step: number): void;

/** True when the current step's required fields are filled in. */
export declare function validateStep(step: number): boolean;

/** Clears the error line under a step. */
export declare function clearErrors(): void;

/** Renders the answer pills that summarise what has been chosen so far. */
export declare function buildSummaryPills(): void;

/**
 * Builds the recommendation and writes it into the results pane.
 *
 * Reads every answer from the DOM by element id, so the inputs must already be
 * rendered with the ids WIZARD_STEPS declares.
 */
export declare function generateRecommendation(): void;

/** The recommendation as a standalone HTML document, for export and print. */
export declare function buildRecommendationDocumentHtml(): string;

/** Opens the recommendation full screen in its own window. */
export declare function openFullViewWindow(): void;

/** Opens the print dialog on the recommendation. */
export declare function openPrintView(): void;

/** Downloads the recommendation as a Word document. */
export declare function exportRecommendationAsWord(): void;

// The section builders, exported because the engine composes them and a caller
// may want one on its own.
export declare function buildSizingPlan(): string;
export declare function buildDrPatternCard(): string;
export declare function buildCyberChecklist(): string;
export declare function buildAssumptionsAndGaps(): string;
export declare function buildHowToPlaybook(): string;
export declare function generateCloudRecommendation(): string;
export declare function getMultiSelectValues(select: unknown): string[];
export declare function getCheckedValues(name: string): string[];

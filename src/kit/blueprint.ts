/**
 * A blueprint is a thing you can build, with the inputs it needs.
 *
 * The generators were previously shaped around the cloud rather than the
 * output: you ticked providers and got the one thing the kit knew how to make.
 * That is backwards. You pick the platform once, then you pick *what you are
 * building* — an EC2 instance with a security group, a versioned S3 bucket, a
 * VM from a vSphere template — and fill in that thing's parameters.
 *
 * So a blueprint owns its own inputs, and the page is generic: it renders
 * whatever the selected blueprint declares and calls `build`. Adding a
 * blueprint is adding one object to one file; no page code changes.
 *
 * Input controls exist so that a choice with a known set of answers is a
 * dropdown rather than a text box someone can misspell. A region, an instance
 * size, an encryption algorithm, a disk mode — all of those have answers the
 * provider will accept and answers it will reject, and offering a free-text box
 * for them just moves the error to plan time.
 */

import type { Finding } from '../core/findings.ts';

export type InputControl = 'select' | 'text' | 'number' | 'toggle' | 'textarea';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface BlueprintInput {
  readonly id: string;
  readonly label: string;
  readonly control: InputControl;
  /** Short note to the right of the label: units, an example, a warning. */
  readonly hint?: string;
  readonly default?: string | number | boolean;
  /** Required for `select`. The only values the provider will accept. */
  readonly options?: readonly SelectOption[];
  readonly min?: number;
  readonly max?: number;
  readonly placeholder?: string;
  /**
   * Show this input only when another input has one of these values, so a
   * blueprint can ask a follow-up question without a second blueprint.
   */
  readonly showWhen?: { readonly input: string; readonly equals: readonly string[] };
}

/** Values as the page collects them, keyed by input id. */
export interface BlueprintValues {
  readonly [id: string]: string | number | boolean | undefined;
}

/**
 * The same values as a ported template reads them.
 *
 * The blueprint templates came over verbatim from the previous toolkit, where
 * they were JavaScript and read their inputs with dot access and no narrowing —
 * `vals.backend_ip.split(',')` and the like. Retyping each of those by hand
 * would mean editing sixty-four working templates to satisfy a compiler, and
 * every edit is a chance to change what one emits. So the adapter boundary is
 * explicit and lives here, rather than being spread through the templates.
 */
export interface TemplateValues {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [id: string]: any;
}

export interface BuildResult {
  /** Filename to contents. Most blueprints emit one file; some emit a few. */
  readonly files: Readonly<Record<string, string>>;
  readonly findings?: readonly Finding[];
}

export interface Blueprint {
  readonly id: string;
  readonly label: string;
  /** One sentence describing what gets built, shown above the parameters. */
  readonly description: string;
  readonly inputs: readonly BlueprintInput[];
  /**
   * Resource or module names this blueprint emits, checked against the
   * committed catalog by the test suite. A renamed resource fails the build
   * rather than reaching a plan.
   */
  readonly emits: readonly string[];
  readonly build: (values: BlueprintValues, name: string) => BuildResult;
}

export interface BlueprintGroup {
  /** Platform id, matching the shared target vocabulary. */
  readonly target: string;
  readonly label: string;
  readonly blueprints: readonly Blueprint[];
}

// --- value helpers ---------------------------------------------------------
// Blueprints read their values through these so an empty box falls back to the
// declared default rather than emitting an empty string into a configuration.

export function str(values: BlueprintValues, id: string, fallback = ''): string {
  const value = values[id];
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text === '' ? fallback : text;
}

export function num(values: BlueprintValues, id: string, fallback: number): number {
  const value = Number(values[id]);
  return Number.isFinite(value) ? value : fallback;
}

export function bool(values: BlueprintValues, id: string, fallback = false): boolean {
  const value = values[id];
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === 'yes' || value === '1';
}

/** Defaults for every input, for a first render and for tests. */
export function defaultValues(blueprint: Blueprint): BlueprintValues {
  const values: Record<string, string | number | boolean> = {};
  for (const input of blueprint.inputs) {
    if (input.default !== undefined) {
      values[input.id] = input.default;
    } else if (input.control === 'select' && input.options?.[0] !== undefined) {
      values[input.id] = input.options[0].value;
    } else if (input.control === 'toggle') {
      values[input.id] = false;
    } else if (input.control === 'number') {
      values[input.id] = input.min ?? 0;
    } else {
      values[input.id] = '';
    }
  }
  return values;
}

/** Whether an input should be shown, given what has been filled in so far. */
export function isVisible(input: BlueprintInput, values: BlueprintValues): boolean {
  if (!input.showWhen) return true;
  const current = String(values[input.showWhen.input] ?? '');
  return input.showWhen.equals.includes(current);
}

export function blueprintsFor(groups: readonly BlueprintGroup[], target: string): readonly Blueprint[] {
  return groups.find((g) => g.target === target)?.blueprints ?? [];
}

export function findBlueprint(
  groups: readonly BlueprintGroup[],
  target: string,
  id: string,
): Blueprint | undefined {
  return blueprintsFor(groups, target).find((b) => b.id === id);
}

/**
 * A safe identifier for a generated name.
 *
 * Terraform labels and Ansible names both reject most punctuation, and a name
 * typed by a person routinely contains a space or a dot.
 */
export function slug(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned === '' ? fallback : cleaned;
}

/**
 * What every hand-written scenario blueprint shares — VMware, Linux and Windows.
 *
 * A scenario is several resources that are built together — a cluster with
 * its DRS rules, a Tier-1 gateway with its segments and firewall — written out
 * the way the per-resource blueprints cannot. Around each one the same
 * `terraform` block, provider block and connection fields are generated as
 * for the per-resource blueprints, so the two kinds read alike and the
 * credentials are handled once: as sensitive variables, never as text.
 */

import type { Blueprint, BlueprintInput, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import type { Finding } from '../../core/findings.ts';
import { newEmitted, PROVIDER_META, providerInputs, wrapConfiguration, type SchemaProvider } from '../schema-blueprints.ts';

export interface ScenarioDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly inputs: readonly BlueprintInput[];
  /** The resource types it writes, for the catalog check. */
  readonly emits: readonly string[];
  /**
   * Other providers the body uses besides the main one — a key from `tls`, a
   * file from `local` — each added to required_providers with its own
   * connection fields.
   */
  readonly alsoUses?: readonly SchemaProvider[];
  /** The picker heading, when it is not the main provider's product. */
  readonly group?: string;
  /** The resources, data sources, variables and outputs, without the terraform and provider blocks. */
  readonly body: (values: TemplateValues, name: string) => string | { readonly hcl: string; readonly findings: readonly Finding[] };
}

export function scenarioGroup(provider: SchemaProvider): string {
  return `${PROVIDER_META[provider].product} · Scenarios (several resources together)`;
}

export function scenario(provider: SchemaProvider, definition: ScenarioDefinition): Blueprint {
  const providers = [provider, ...(definition.alsoUses ?? [])];
  return {
    id: definition.id,
    label: definition.label,
    group: definition.group ?? scenarioGroup(provider),
    description: definition.description,
    inputs: [...definition.inputs, ...[...new Set(providers)].flatMap((p) => providerInputs(p))],
    emits: definition.emits,
    build: (values: BlueprintValues, name: string) => {
      const produced = definition.body(values as TemplateValues, name || definition.id);
      const hcl = typeof produced === 'string' ? produced : produced.hcl;
      const findings = typeof produced === 'string' ? [] : produced.findings;
      const out = newEmitted();
      const main = wrapConfiguration(providers, values, [hcl.trim()], out);
      return { files: { 'main.tf': main }, findings: [...findings, ...out.findings] };
    },
  };
}

// --- small template helpers --------------------------------------------------

/** A quoted HCL string, or the reference itself when the value is one. */
export function q(value: unknown): string {
  const text = String(value ?? '').trim();
  if (/^(var|local|data|module)\.[\w.[\]"*-]+$/.test(text) || /^[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z_][\w-]*\.[\w.[\]]+$/.test(text)) return text;
  // A function replacement: in a replacement string `$$` is itself an escape
  // for `$`, so '$${' would write `${` back and reopen the interpolation.
  return JSON.stringify(text).replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
}

/** A comma- or newline-separated field as a list of strings. */
export function items(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `["a", "b"]` from a comma-separated field. */
export function qlist(value: unknown): string {
  return `[${items(value).map(q).join(', ')}]`;
}

/** Lines of `name=value` (or `name value`) as pairs. */
export function pairs(value: unknown): [string, string][] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^([^=\s:]+)\s*[=:\s]\s*(.*)$/.exec(line);
      return m ? [m[1] as string, (m[2] ?? '').trim()] : [line, ''];
    });
}

/** A Terraform identifier from a free-text name. */
export function ident(value: unknown, fallback = 'this'): string {
  const id = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (id === '') return fallback;
  return /^[a-z_]/.test(id) ? id : `n_${id}`;
}

export function on(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

export function n(value: unknown, fallback: number): number {
  const v = Number(value);
  return Number.isFinite(v) && String(value).trim() !== '' ? v : fallback;
}

export const YES_NO_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

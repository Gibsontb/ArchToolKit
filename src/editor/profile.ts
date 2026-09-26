/**
 * What the data editor knows about a kind of file.
 *
 * The editing itself is the same for every JSON or YAML document (./doc.ts).
 * What differs is which fields have a fixed set of answers, what makes the
 * document wrong, and what to call things — a VCF spec's `hostSpecs` are
 * "Hosts", an Ansible task is named by its `name`. A profile carries that for
 * one kind of file, and says how sure it is that a given document is one.
 *
 * Profiles see the document as the editor holds it: one value for a file with
 * one document, and for a YAML file with several (a Kubernetes manifest set)
 * the list of them, with paths starting at the document number. `perDocument`
 * wraps a profile written for one document so it works on either.
 */

import type { Finding } from '../core/findings.ts';
import { getAt, type Json, type Path } from './doc.ts';

export type Family = 'vcf' | 'ansible' | 'terraform' | 'aws' | 'google' | 'azure' | 'oracle' | 'f5' | 'kubernetes' | 'generic';

export const FAMILY_LABELS: Readonly<Record<Family, string>> = {
  vcf: 'VMware Cloud Foundation',
  ansible: 'Ansible',
  terraform: 'Terraform',
  aws: 'AWS',
  google: 'Google Cloud (GCP)',
  azure: 'Azure',
  oracle: 'Oracle Cloud',
  f5: 'F5 BIG-IP',
  kubernetes: 'Kubernetes',
  generic: 'Any JSON or YAML',
};

export interface Profile {
  readonly id: string;
  readonly family: Family;
  readonly label: string;
  /** The format these files are usually written in, for a new download. */
  readonly format: 'json' | 'yaml';
  /** Where the rules come from, shown beside the findings. */
  readonly source?: string;
  /**
   * How sure this profile is that the document is one of its kind, 0 to 1.
   * `name` is the file name, when there is one.
   */
  detect(doc: Json, name: string): number;
  /** The fixed answers for the field at `path`, when it has them. */
  choices?(path: Path, doc: Json): readonly string[] | undefined;
  /** What is wrong with the document. Paths are as `pathString` writes them. */
  validate?(doc: Json): Finding[];
  /**
   * Fetch the schema data `validate` and `choices` need for this document —
   * the chunks for the resource types, modules or kinds it names — so the page
   * can check again once it has them. In Node the data is read as it is asked
   * for, so tests and tools need not await this.
   */
  prepare?(doc: Json): Promise<void>;
  /** Labels for keys that the generic rule would get wrong. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Keys cleared on a copied list entry (see newEntry). */
  readonly identity?: RegExp;
  /** A short title for a list entry, to show in place of "Item 3". */
  itemTitle?(value: Json, path: Path): string | undefined;
}

/**
 * The profile, lifted to a document that may be a list of documents.
 *
 * With `multi`, the top-level list is the file's documents: detection takes
 * the best of them, validation runs on each and prefixes its paths, and the
 * answer set for `[2].spec.type` is the one-document profile's for `spec.type`.
 */
export function perDocument(profile: Profile, multi: boolean): Profile {
  if (!multi) return profile;
  const docs = (doc: Json): Json[] => (Array.isArray(doc) ? doc : [doc]);
  return {
    ...profile,
    detect: (doc, name) => Math.max(0, ...docs(doc).map((d) => profile.detect(d, name))),
    choices: profile.choices
      ? (path, doc) => {
          const [index, ...rest] = path;
          if (typeof index !== 'number') return undefined;
          return profile.choices?.(rest, docs(doc)[index] ?? null);
        }
      : undefined,
    prepare: profile.prepare ? (doc) => Promise.all(docs(doc).map((d) => profile.prepare?.(d))).then(() => undefined) : undefined,
    validate: profile.validate
      ? (doc) =>
          docs(doc).flatMap((d, i) =>
            (profile.validate?.(d) ?? []).map((f) => ({ ...f, path: f.path ? `[${i}]${f.path.startsWith('[') ? '' : '.'}${f.path}` : `[${i}]` })),
          )
      : undefined,
    itemTitle: (value, path) => {
      if (path.length === 1 && typeof path[0] === 'number') return profile.itemTitle?.(value, []) ?? undefined;
      return profile.itemTitle?.(value, path.slice(1));
    },
  };
}

/**
 * A value computed when the file is used, not a literal: an ARM or Policy
 * expression (`[parameters('effect')]`), a Jinja template (`{{ state }}`),
 * a Terraform or CloudFormation interpolation (`${var.x}`).
 */
export function isExpression(value: string): boolean {
  const v = value.trim();
  return (v.startsWith('[') && v.endsWith(']') && !v.startsWith('[[')) || v.includes('{{') || v.includes('${');
}

/**
 * The fixed answers for the field at `path`, for the editor to offer as a
 * dropdown. None when the field holds an expression: that value is decided
 * later, and a dropdown would force it back to a literal.
 */
export function choicesAt(profile: Profile, doc: Json, path: Path, multi = false): readonly string[] | undefined {
  const value = getAt(doc, path);
  if (typeof value === 'string' && isExpression(value)) return undefined;
  return perDocument(profile, multi).choices?.(path, doc);
}

// ---------------------------------------------------------------------------
// Small helpers the profiles share
// ---------------------------------------------------------------------------

export function isObj(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

export function str(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A value in a list, or the value itself: IAM's `"Action": "s3:*"` or `["s3:*"]`. */
export function asList(value: Json | undefined): Json[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The key names of `path`, without the list indices: what a choice rule is matched on. */
export function keysOf(path: Path): string[] {
  return path.filter((p): p is string => typeof p === 'string');
}

export function last(path: Path): string | number | undefined {
  return path[path.length - 1];
}

/** Levenshtein distance, for "did you mean". */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j] as number;
      row[j] = Math.min(cur + 1, (row[j - 1] as number) + 1, prev + (a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length] as number;
}

/** The closest of `options` to `value`, when it is close enough to be a typo. */
export function didYouMean(value: string, options: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(value, o);
    if (d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(value.length / 4)) ? best : undefined;
}

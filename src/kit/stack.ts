/**
 * Several blueprints assembled into one thing.
 *
 * Terraform calls it a root module — a `terraform apply` that stands up a
 * whole landing zone; Ansible calls it a site playbook — one
 * `ansible-playbook` run that configures the lot. Both pages hold the same
 * list of items and hand it to their own builder, so this is the vocabulary
 * they share.
 */

import type { Finding } from '../core/findings.ts';
import type { Blueprint, BlueprintValues } from './blueprint.ts';

export interface StackItem {
  /** Stable id, so the list can be reordered without losing references. */
  readonly id: string;
  readonly blueprintId: string;
  /** What this item is called: its file name, and the prefix on what it makes. */
  readonly label: string;
  readonly values: BlueprintValues;
}

export interface StackReference {
  /** The expression as it goes into a field, without its wrapper. */
  readonly expression: string;
  /** Which item it comes from, or where it is defined. */
  readonly item: string;
  /** What it belongs to: `aws_vpc.this`, `module.vpc`, `group_vars/all.yml`. */
  readonly address: string;
  readonly attribute: string;
}

export interface StackBuild {
  readonly files: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
  /** Every value an item exposes to the others, in list order. */
  readonly references: readonly StackReference[];
}

export type BlueprintLookup = (id: string) => Blueprint | undefined;

export interface StackOptions {
  readonly target?: string;
  /** What the whole thing is called: the README title, the site playbook name. */
  readonly stackName?: string;
}

/** A file name and an identifier from an item's label. */
export function slug(label: string, fallback: string): string {
  const s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** `01-`, `02-`: the order the list is in, for reading. */
export function numbered(index: number, name: string, extension: string): string {
  return `${String(index + 1).padStart(2, '0')}-${name}${extension}`;
}

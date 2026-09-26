/**
 * The Kubernetes schema, a group at a time.
 *
 * Every built-in kind's fields, their types, which are required and the closed
 * sets, from the release's OpenAPI document (tools/fetch-editor-kubernetes.mjs).
 * The definitions are in web/data/editor/kubernetes/<group>.json; core.json
 * has the ones several groups share (ObjectMeta, PodSpec, Container…) and is
 * loaded with every group. In the browser a group is fetched when a file names
 * one of its kinds (`loadKind`); in Node it is read from disk when first asked
 * for, so tests and tools need not await anything.
 */

import { KUBERNETES_SCHEMA_INDEX } from './kubernetes-schema-index.ts';

/**
 * A field's schema, compacted:
 *   's' string, 'i' integer, 'n' number, 'b' boolean, 'B' base64 string,
 *   'q' resource.Quantity, 'io' int-or-string, 'o' free-form object, '*' anything,
 *   '#name' another definition.
 */
export type KNode = string | KObject | KMap | KList | KScalar;
export interface KObject {
  readonly t: 'o';
  readonly p: Readonly<Record<string, KNode>>;
  readonly r?: readonly string[];
}
export interface KMap {
  readonly t: 'm';
  readonly v: KNode;
}
export interface KList {
  readonly t: 'a';
  readonly i: KNode;
}
/** A scalar with a closed set of answers. */
export interface KScalar {
  readonly t: string;
  readonly e: readonly (string | number | boolean)[];
}

export const KUBERNETES_VERSION = KUBERNETES_SCHEMA_INDEX.version;
export const KUBERNETES_SCHEMA_SOURCE = `Kubernetes ${KUBERNETES_SCHEMA_INDEX.version} OpenAPI schema (fetched ${KUBERNETES_SCHEMA_INDEX.fetched})`;

const KINDS = KUBERNETES_SCHEMA_INDEX.kinds;

/** The built-in apiVersion, served by the release. */
export function isBuiltinApiVersion(apiVersion: string): boolean {
  return Object.hasOwn(KINDS, apiVersion);
}

/** The API group of an apiVersion: '' for `v1`. */
export function groupOf(apiVersion: string): string {
  const slash = apiVersion.indexOf('/');
  return slash < 0 ? '' : apiVersion.slice(0, slash);
}

/** Whether the group is a built-in one, whatever the version. */
export function isBuiltinGroup(group: string): boolean {
  return Object.keys(KINDS).some((av) => groupOf(av) === group);
}

/** The versions a built-in group is served at. */
export function versionsOf(group: string): string[] {
  return Object.keys(KINDS).filter((av) => groupOf(av) === group);
}

/** The kinds an apiVersion serves. */
export function kindsOf(apiVersion: string): string[] {
  return Object.keys(KINDS[apiVersion] ?? {});
}

/** The apiVersions that serve a kind. */
export function apiVersionsOf(kind: string): string[] {
  return Object.keys(KINDS).filter((av) => KINDS[av]?.[kind] !== undefined);
}

// --- the files ----------------------------------------------------------------

const DEFS = new Map<string, KNode>();
const LOADED = new Set<string>();
const FETCHING = new Map<string, Promise<void>>();

/** Node's fs, when there is one: tests and tools read schema files straight from disk. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFs: any = (globalThis as any).process?.getBuiltinModule?.('node:fs');

function chunkUrl(chunk: string): URL {
  // Built, this module is web/lib/editor/ and the data web/data/editor/;
  // run from source (tests, tools), it is src/editor/.
  const base = import.meta.url.includes('/src/editor/') ? '../../web/data/editor/kubernetes/' : '../../data/editor/kubernetes/';
  return new URL(`${base}${chunk}.json`, import.meta.url);
}

function store(chunk: string, file: Record<string, KNode>): void {
  for (const [name, node] of Object.entries(file)) DEFS.set(name, node);
  LOADED.add(chunk);
}

function fetchChunk(chunk: string): Promise<void> {
  if (LOADED.has(chunk)) return Promise.resolve();
  let pending = FETCHING.get(chunk);
  if (!pending) {
    pending = fetch(chunkUrl(chunk))
      .then((r) => {
        if (!r.ok) throw new Error(`kubernetes/${chunk}.json: HTTP ${r.status}`);
        return r.json() as Promise<Record<string, KNode>>;
      })
      .then((file) => store(chunk, file))
      .catch((err: unknown) => {
        FETCHING.delete(chunk);
        throw err;
      });
    FETCHING.set(chunk, pending);
  }
  return pending;
}

/** In Node, read the file now; in the browser, whether it has been fetched. */
function ready(chunk: string): boolean {
  if (LOADED.has(chunk)) return true;
  if (!nodeFs) return false;
  try {
    store(chunk, JSON.parse(nodeFs.readFileSync(chunkUrl(chunk), 'utf8')) as Record<string, KNode>);
  } catch {
    return false;
  }
  return true;
}

/** Fetch the files a kind's schema is in; resolves at once for a kind that is not built in. */
export function loadKind(apiVersion: string, kind: string): Promise<void> {
  const entry = KINDS[apiVersion]?.[kind];
  if (!entry) return Promise.resolve();
  return Promise.all([fetchChunk('core'), fetchChunk(entry[0])]).then(() => undefined);
}

/**
 * The schema of a built-in kind: undefined when the kind is not built in, or
 * (in the browser) until `loadKind` has fetched it.
 */
export function kindSchema(apiVersion: string, kind: string): KNode | undefined {
  const entry = KINDS[apiVersion]?.[kind];
  if (!entry) return undefined;
  if (!ready('core') || !ready(entry[0])) return undefined;
  return DEFS.get(entry[1]);
}

/** A node with its `#name` reference followed. */
export function resolve(node: KNode | undefined): KNode | undefined {
  let n = node;
  for (let hops = 0; typeof n === 'string' && n.startsWith('#') && hops < 8; hops += 1) n = DEFS.get(n.slice(1));
  return n;
}

export function isObjectNode(node: KNode | undefined): node is KObject {
  return typeof node === 'object' && node.t === 'o' && 'p' in node;
}
export function isMapNode(node: KNode | undefined): node is KMap {
  return typeof node === 'object' && node.t === 'm';
}
export function isListNode(node: KNode | undefined): node is KList {
  return typeof node === 'object' && node.t === 'a';
}

/** The scalar type code of a node: 's', 'i', 'q'… — or 'o', 'm', 'a' for the structured ones. */
export function typeOf(node: KNode): string {
  return typeof node === 'string' ? node : node.t;
}

/** The closed set of a node, when it has one. */
export function enumOf(node: KNode | undefined): readonly (string | number | boolean)[] | undefined {
  return typeof node === 'object' && 'e' in node ? node.e : undefined;
}

/** The node at a path under a kind's schema: keys walk fields and maps, numbers walk lists. */
export function nodeAt(root: KNode | undefined, path: readonly (string | number)[]): KNode | undefined {
  let node = resolve(root);
  for (const step of path) {
    if (node === undefined) return undefined;
    if (typeof step === 'number') node = isListNode(node) ? resolve(node.i) : undefined;
    else if (isObjectNode(node)) node = Object.hasOwn(node.p, step) ? resolve(node.p[step]) : undefined;
    else if (isMapNode(node)) node = resolve(node.v);
    else return undefined;
  }
  return node;
}

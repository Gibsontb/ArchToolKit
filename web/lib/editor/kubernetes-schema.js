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

import { KUBERNETES_SCHEMA_INDEX } from './kubernetes-schema-index.js';

/**
 * A field's schema, compacted:
 *   's' string, 'i' integer, 'n' number, 'b' boolean, 'B' base64 string,
 *   'q' resource.Quantity, 'io' int-or-string, 'o' free-form object, '*' anything,
 *   '#name' another definition.
 */
                                                              
                          
                  
                                              
                                 
 
                       
                  
                    
 
                        
                  
                    
 
/** A scalar with a closed set of answers. */
                          
                     
                                                     
 

export const KUBERNETES_VERSION = KUBERNETES_SCHEMA_INDEX.version;
export const KUBERNETES_SCHEMA_SOURCE = `Kubernetes ${KUBERNETES_SCHEMA_INDEX.version} OpenAPI schema (fetched ${KUBERNETES_SCHEMA_INDEX.fetched})`;

const KINDS = KUBERNETES_SCHEMA_INDEX.kinds;

/** The built-in apiVersion, served by the release. */
export function isBuiltinApiVersion(apiVersion        )          {
  return Object.hasOwn(KINDS, apiVersion);
}

/** The API group of an apiVersion: '' for `v1`. */
export function groupOf(apiVersion        )         {
  const slash = apiVersion.indexOf('/');
  return slash < 0 ? '' : apiVersion.slice(0, slash);
}

/** Whether the group is a built-in one, whatever the version. */
export function isBuiltinGroup(group        )          {
  return Object.keys(KINDS).some((av) => groupOf(av) === group);
}

/** The versions a built-in group is served at. */
export function versionsOf(group        )           {
  return Object.keys(KINDS).filter((av) => groupOf(av) === group);
}

/** The kinds an apiVersion serves. */
export function kindsOf(apiVersion        )           {
  return Object.keys(KINDS[apiVersion] ?? {});
}

/** The apiVersions that serve a kind. */
export function apiVersionsOf(kind        )           {
  return Object.keys(KINDS).filter((av) => KINDS[av]?.[kind] !== undefined);
}

// --- the files ----------------------------------------------------------------

const DEFS = new Map               ();
const LOADED = new Set        ();
const FETCHING = new Map                       ();

/** Node's fs, when there is one: tests and tools read schema files straight from disk. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFs      = (globalThis       ).process?.getBuiltinModule?.('node:fs');

function chunkUrl(chunk        )      {
  // Built, this module is web/lib/editor/ and the data web/data/editor/;
  // run from source (tests, tools), it is src/editor/.
  const base = import.meta.url.includes('/src/editor/') ? '../../web/data/editor/kubernetes/' : '../../data/editor/kubernetes/';
  return new URL(`${base}${chunk}.json`, import.meta.url);
}

function store(chunk        , file                       )       {
  for (const [name, node] of Object.entries(file)) DEFS.set(name, node);
  LOADED.add(chunk);
}

function fetchChunk(chunk        )                {
  if (LOADED.has(chunk)) return Promise.resolve();
  let pending = FETCHING.get(chunk);
  if (!pending) {
    pending = fetch(chunkUrl(chunk))
      .then((r) => {
        if (!r.ok) throw new Error(`kubernetes/${chunk}.json: HTTP ${r.status}`);
        return r.json()                                  ;
      })
      .then((file) => store(chunk, file))
      .catch((err         ) => {
        FETCHING.delete(chunk);
        throw err;
      });
    FETCHING.set(chunk, pending);
  }
  return pending;
}

/** In Node, read the file now; in the browser, whether it has been fetched. */
function ready(chunk        )          {
  if (LOADED.has(chunk)) return true;
  if (!nodeFs) return false;
  try {
    store(chunk, JSON.parse(nodeFs.readFileSync(chunkUrl(chunk), 'utf8'))                         );
  } catch {
    return false;
  }
  return true;
}

/** Fetch the files a kind's schema is in; resolves at once for a kind that is not built in. */
export function loadKind(apiVersion        , kind        )                {
  const entry = KINDS[apiVersion]?.[kind];
  if (!entry) return Promise.resolve();
  return Promise.all([fetchChunk('core'), fetchChunk(entry[0])]).then(() => undefined);
}

/**
 * The schema of a built-in kind: undefined when the kind is not built in, or
 * (in the browser) until `loadKind` has fetched it.
 */
export function kindSchema(apiVersion        , kind        )                    {
  const entry = KINDS[apiVersion]?.[kind];
  if (!entry) return undefined;
  if (!ready('core') || !ready(entry[0])) return undefined;
  return DEFS.get(entry[1]);
}

/** A node with its `#name` reference followed. */
export function resolve(node                   )                    {
  let n = node;
  for (let hops = 0; typeof n === 'string' && n.startsWith('#') && hops < 8; hops += 1) n = DEFS.get(n.slice(1));
  return n;
}

export function isObjectNode(node                   )                  {
  return typeof node === 'object' && node.t === 'o' && 'p' in node;
}
export function isMapNode(node                   )               {
  return typeof node === 'object' && node.t === 'm';
}
export function isListNode(node                   )                {
  return typeof node === 'object' && node.t === 'a';
}

/** The scalar type code of a node: 's', 'i', 'q'… — or 'o', 'm', 'a' for the structured ones. */
export function typeOf(node       )         {
  return typeof node === 'string' ? node : node.t;
}

/** The closed set of a node, when it has one. */
export function enumOf(node                   )                                                     {
  return typeof node === 'object' && 'e' in node ? node.e : undefined;
}

/** The node at a path under a kind's schema: keys walk fields and maps, numbers walk lists. */
export function nodeAt(root                   , path                              )                    {
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

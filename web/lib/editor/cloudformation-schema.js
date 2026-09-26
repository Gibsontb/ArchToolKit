/**
 * CloudFormation resource schemas, a service at a time.
 *
 * tools/fetch-editor-cloudformation.mjs compacts the CloudFormation registry's
 * ~1,800 resource schemas into web/data/editor/cloudformation/<service>.json
 * (~2 MB in all) and lists every type in ./cloudformation-schema-index.ts.
 * The browser fetches a service's file when a template names one of its
 * types (`loadCfnType`); in Node the file is read as it is asked for, so
 * tests need not await anything.
 *
 * A property's spec is a type code, or [code, enum] when it has a closed set:
 *   s string, n number, i integer, b boolean, j anything,
 *   o:Def an object shaped by definition Def, a:<code> a list of <code>.
 */

import { CFN_SCHEMA_INDEX } from './cloudformation-schema-index.js';

                                                                    

                           
                         
                                                
                             
                                 
                                                                                         
                 
 

                                                 
                                     
                                                  
                                                                                        
                                  
                                                                                
                                  
 

export const CFN_SCHEMA_SOURCE = CFN_SCHEMA_INDEX.source;
export const CFN_SCHEMA_FETCHED = CFN_SCHEMA_INDEX.fetched;

/** Every resource type the registry lists. */
export function cfnTypes()           {
  return Object.keys(CFN_SCHEMA_INDEX.types);
}

export function isKnownCfnType(type        )          {
  return Object.prototype.hasOwnProperty.call(CFN_SCHEMA_INDEX.types, type);
}

/** The types in the same file (service) as `type`, when it is a known one. */
export function cfnServiceTypes(type        )                       {
  if (!isKnownCfnType(type)) return undefined;
  const file = CFN_SCHEMA_INDEX.types[type];
  return Object.keys(CFN_SCHEMA_INDEX.types).filter((t) => CFN_SCHEMA_INDEX.types[t] === file);
}

const LOADED = new Map                       ();
const FETCHING = new Map                       ();

/** Node's fs, when there is one: tests and tools read schema files straight from disk. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFs      = (globalThis       ).process?.getBuiltinModule?.('node:fs');

function schemaUrl(file        )      {
  // Built, this module is web/lib/editor/ and the data web/data/editor/;
  // run from source (tests, tools), it is src/editor/.
  const base = import.meta.url.includes('/src/editor/') ? '../../web/data/editor/cloudformation/' : '../../data/editor/cloudformation/';
  return new URL(`${base}${file}.json`, import.meta.url);
}

function store(file                               )       {
  for (const [type, schema] of Object.entries(file)) LOADED.set(type, schema);
}

/** Fetch the file `type`'s schema is in; resolves at once for a loaded or unknown type. */
export function loadCfnType(type        )                {
  if (LOADED.has(type) || !isKnownCfnType(type)) return Promise.resolve();
  if (nodeFs) {
    // Node's fetch cannot read file: URLs; read it from disk instead.
    try {
      cfnTypeSchema(type);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err);
    }
  }
  const file = CFN_SCHEMA_INDEX.types[type]          ;
  let pending = FETCHING.get(file);
  if (!pending) {
    pending = fetch(schemaUrl(file))
      .then((r) => {
        if (!r.ok) throw new Error(`cloudformation/${file}.json: HTTP ${r.status}`);
        return r.json()                                          ;
      })
      .then(store)
      .catch((err         ) => {
        FETCHING.delete(file);
        throw err;
      });
    FETCHING.set(file, pending);
  }
  return pending;
}

/** The schema for `type`, when it is loaded (always, in Node, for a known type). */
export function cfnTypeSchema(type        )                            {
  const loaded = LOADED.get(type);
  if (loaded || !nodeFs || !isKnownCfnType(type)) return loaded;
  // In Node, read it now: tests and tools then need not await anything.
  store(JSON.parse(nodeFs.readFileSync(schemaUrl(CFN_SCHEMA_INDEX.types[type]          ), 'utf8')));
  return LOADED.get(type);
}

/**
 * The Terraform Map, joined to what was just generated.
 *
 * The map answers the question that comes before the generator's: given a
 * domain, which resource is the one to reach for, and what is the pattern
 * around it. That is a browsing question, and it has its own page.
 *
 * But once something has been generated, the map becomes reference for what is
 * on the screen — and that belongs beside the output rather than one navigation
 * away. So this reads the resource types out of the generated HCL and finds the
 * rows and worked examples that talk about them.
 *
 * The join key is the resource type name, which both sides already check
 * against the same committed provider catalog. Nothing here invents a
 * correspondence: a row matches because it names the resource.
 *
 * A generated resource with no row in the map is also worth knowing about, and
 * it is a gap in the map rather than a problem with the generated code. It is
 * reported as an info finding, in the same way a stale name in the map is
 * reported on the map page.
 */

import { info,              } from '../core/findings.js';
import { mapFor } from './maps.js';
                                                             
                                                  

/** One row of the map that talks about a resource the generated code creates. */
                               
                                                                             
                           
                             
                                      
                                    
                                                              
                                      
 

                            
                               
                                                                     
                                        
                                                 
                                         
                                                                
                                                                            
                                                        
                                       
                                        
 

/**
 * Every resource and data source type in a set of generated files.
 *
 * Read from the HCL rather than from the blueprint's `emits`, because `emits`
 * is a declaration and the HCL is the fact. Many blueprints declare nothing;
 * all of them produce something.
 */
export function resourceTypesIn(files                                  )           {
  const found = new Set        ();
  const declaration = /^\s*(resource|data)\s+"([a-z][a-z0-9_]*)"/gm;
  for (const [name, body] of Object.entries(files)) {
    if (!name.endsWith('.tf') && !name.endsWith('.tf.json')) continue;
    for (const match of body.matchAll(declaration)) {
      const type = match[2];
      if (type) found.add(type);
    }
  }
  return [...found].sort();
}

/** Every module source a set of generated files calls. */
export function modulesIn(files                                  )           {
  const found = new Set        ();
  const source = /^\s*source\s*=\s*"([^"]+)"/gm;
  for (const [name, body] of Object.entries(files)) {
    if (!name.endsWith('.tf')) continue;
    for (const match of body.matchAll(source)) {
      const value = match[1];
      // A relative path is a local module, which the map has nothing to say about.
      if (value && !value.startsWith('.') && !value.startsWith('/')) found.add(value);
    }
  }
  return [...found].sort();
}

/** Rows of one map that name any of these resources, with what they matched on. */
function rowsFor(map          , resources                   )                 {
  const wanted = new Set(resources);
  const out                 = [];
  for (const section of map.sections) {
    for (const table of section.tables ?? []) {
      for (const row of table.rows) {
        const matched = row.resources.filter((name) => wanted.has(name));
        if (matched.length === 0) continue;
        out.push({
          section: section.title,
          sectionId: section.id,
          headers: table.headers,
          cells: row.cells,
          matched,
        });
      }
    }
  }
  return out;
}

/**
 * The reference for one generated output.
 *
 * Returns null when the platform has no map — vSphere and VCF do not — rather
 * than an empty panel, because an empty panel reads as "the map knows nothing
 * about this" when the truth is that there is no map to consult.
 */
export function referenceFor(target        , files                                  )                   {
  const map = mapFor(target);
  if (!map) return null;

  const resources = resourceTypesIn(files);
  if (resources.length === 0) return null;

  const rows = rowsFor(map, resources);
  const matched = new Set(rows.flatMap((row) => row.matched));
  const unmapped = resources.filter((name) => !matched.has(name));

  // Examples belong to sections, not to rows. Anything from a section that
  // matched is worth offering — that is the worked version of this pattern.
  const sections = new Set(rows.map((row) => row.sectionId));
  const examples = map.sections
    .filter((section) => sections.has(section.id))
    .flatMap((section) => (section.examples ?? []).map((example) => ({ ...example, section: section.title })));

  const findings            = [];
  if (rows.length > 0) {
    findings.push(
      info('terraform.reference.rows', `The map has ${rows.length} row${rows.length === 1 ? '' : 's'} about the ${matched.size} resource type${matched.size === 1 ? '' : 's'} this builds.`, {
        source: 'ArchToolKit',
      }),
    );
  }
  if (unmapped.length > 0) {
    findings.push(
      info('terraform.reference.unmapped', `The map says nothing about ${unmapped.join(', ')}. That is a gap in the map rather than a problem with what was generated — the map is the thing to extend.`, {
        source: 'ArchToolKit',
      }),
    );
  }

  return { target: map.target, resources, rows, examples, unmapped, findings };
}

/** How many rows of the map cover a platform's generated resources overall. */
export function referenceCoverage(target        , files                                  )                                    {
  const reference = referenceFor(target, files);
  if (!reference) return { mapped: 0, total: 0 };
  return { mapped: reference.resources.length - reference.unmapped.length, total: reference.resources.length };
}

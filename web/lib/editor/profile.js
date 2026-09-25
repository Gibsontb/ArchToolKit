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

                                                   
import { getAt,                      } from './doc.js';

                                                                                                                               

export const FAMILY_LABELS                                   = {
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

                          
                      
                          
                         
                                                                           
                                   
                                                              
                           
     
                                                                           
                                                
     
                                          
                                                                     
                                                                 
                                                                                
                                  
                                                               
                                                     
                                                            
                             
                                                                      
                                                          
 

/**
 * The profile, lifted to a document that may be a list of documents.
 *
 * With `multi`, the top-level list is the file's documents: detection takes
 * the best of them, validation runs on each and prefixes its paths, and the
 * answer set for `[2].spec.type` is the one-document profile's for `spec.type`.
 */
export function perDocument(profile         , multi         )          {
  if (!multi) return profile;
  const docs = (doc      )         => (Array.isArray(doc) ? doc : [doc]);
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
export function isExpression(value        )          {
  const v = value.trim();
  return (v.startsWith('[') && v.endsWith(']') && !v.startsWith('[[')) || v.includes('{{') || v.includes('${');
}

/**
 * The fixed answers for the field at `path`, for the editor to offer as a
 * dropdown. None when the field holds an expression: that value is decided
 * later, and a dropdown would force it back to a literal.
 */
export function choicesAt(profile         , doc      , path      , multi = false)                                {
  const value = getAt(doc, path);
  if (typeof value === 'string' && isExpression(value)) return undefined;
  return perDocument(profile, multi).choices?.(path, doc);
}

// ---------------------------------------------------------------------------
// Small helpers the profiles share
// ---------------------------------------------------------------------------

export function isObj(value                  )                                   {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

export function str(value                  )                     {
  return typeof value === 'string' ? value : undefined;
}

/** A value in a list, or the value itself: IAM's `"Action": "s3:*"` or `["s3:*"]`. */
export function asList(value                  )         {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The key names of `path`, without the list indices: what a choice rule is matched on. */
export function keysOf(path      )           {
  return path.filter((p)              => typeof p === 'string');
}

export function last(path      )                              {
  return path[path.length - 1];
}

/** Levenshtein distance, for "did you mean". */
export function distance(a        , b        )         {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0]          ;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j]          ;
      row[j] = Math.min(cur + 1, (row[j - 1]          ) + 1, prev + (a[i - 1]?.toLowerCase() === b[j - 1]?.toLowerCase() ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]          ;
}

/** The closest of `options` to `value`, when it is close enough to be a typo. */
export function didYouMean(value        , options                  )                     {
  let best                    ;
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

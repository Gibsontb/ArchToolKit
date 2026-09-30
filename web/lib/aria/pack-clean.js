/**
 * Take dashboards out of a VCF Operations export, and write the export back.
 *
 * A content package is a zip: `dashboards/<owner id>` is itself a zip holding
 * `dashboard/dashboard.json` — `{entries, dashboards: [...], uuid}`, every
 * dashboard that owner has — and `configuration.json` counts them, in total and
 * by owner. A dashboard exported on its own is that inner zip, or the .json.
 *
 * Removing a dashboard removes its object from the `dashboards` array and
 * nothing else: the rest of the file is kept as the text it was (no re-writing
 * of numbers or key order), the counts are corrected, and an owner left with
 * no dashboards loses its bundle and its sharing entry, as an export of that
 * state would have none.
 */

import { openZip, looksLikeZip, stripBom,                 } from '../core/zip.js';
import { zip } from '../kit/archive.js';

                                   
                            
                      
                                                          
                        
                                                                                      
                         
 

                              
                             
                                                                           
                           
                                                                
                                  
 

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const MAX_NESTING = 4;

/** The end of the JSON value that starts at `start` (an object, array, string, or bare token). */
function valueEnd(text        , start        )         {
  const open = text[start];
  if (open === '"') {
    for (let i = start + 1; i < text.length; i++) {
      if (text[i] === '\\') i++;
      else if (text[i] === '"') return i + 1;
    }
    return text.length;
  }
  if (open !== '{' && open !== '[') {
    let i = start;
    while (i < text.length && !',]}'.includes(text[i] ) && !/\s/.test(text[i] )) i++;
    return i;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i = valueEnd(text, i) - 1;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Where the top-level `dashboards` array starts and ends in a dashboard file's text. */
function dashboardsSpan(text        )                                        {
  let i = text.indexOf('{');
  if (i === -1) return null;
  i++;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i] )) i++;
    if (text[i] !== '"') return null;
    const keyEnd = valueEnd(text, i);
    const key = text.slice(i + 1, keyEnd - 1);
    i = keyEnd;
    while (i < text.length && /[\s:]/.test(text[i] )) i++;
    const end = valueEnd(text, i);
    if (key === 'dashboards' && text[i] === '[') return { start: i, end };
    i = end;
  }
  return null;
}

/**
 * A dashboard file's text with the matching dashboards cut out of its array.
 * Returns the new text, how many were cut, and how many are left.
 */
export function removeFromDashboardJson(text        , matches                                                 )                                                  {
  const span = dashboardsSpan(text);
  if (!span) return { text, removed: 0, left: 0 };
  const kept           = [];
  let removed = 0;
  let i = span.start + 1;
  while (i < span.end - 1) {
    while (i < span.end - 1 && /[\s,]/.test(text[i] )) i++;
    if (i >= span.end - 1) break;
    const end = valueEnd(text, i);
    const piece = text.slice(i, end);
    let parsed         ;
    try {
      parsed = JSON.parse(piece);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && matches(parsed                           )) removed++;
    else kept.push(piece);
    i = end;
  }
  if (removed === 0) return { text, removed: 0, left: kept.length };
  // The array's own indentation: what sat between "[" and its first element.
  const lead = /^\[(\s*)/.exec(text.slice(span.start, span.end))?.[1] ?? '';
  const tail = /(\s*)\]$/.exec(text.slice(span.start, span.end))?.[1] ?? '';
  const array = kept.length > 0 ? `[${lead}${kept.join(`,${lead}`)}${tail}]` : '[]';
  return { text: text.slice(0, span.start) + array + text.slice(span.end), removed, left: kept.length };
}

const same = (a         , b         )          => JSON.stringify(a) === JSON.stringify(b);

                
                                                 
                  
                         
                                                                               
                                      
                                                        
                                            
 

/** Rewrites one file; null means it held dashboards and none are left. */
async function rewrite(where        , bytes            , depth        , walk      )                                                             {
  if (looksLikeZip(bytes)) {
    if (depth >= MAX_NESTING) return { bytes, left: null };
    let archive            ;
    try {
      archive = openZip(bytes);
    } catch {
      return { bytes, left: null };
    }
    const out                             = {};
    let changed = false;
    let held                = null;
    for (const entry of archive.names) {
      if (entry.endsWith('/')) continue;
      const data = await archive.bytes(entry);
      const lower = entry.toLowerCase();
      const candidate = lower.endsWith('.json') || lower.endsWith('.zip') || lower.startsWith('dashboards/') || !/\.[a-z0-9]+$/.test(lower.split('/').pop() ?? '');
      if (!candidate || lower === 'configuration.json') {
        out[entry] = data;
        continue;
      }
      const before = walk.removed;
      const result = await rewrite(`${where}/${entry}`, data, depth + 1, walk);
      const owner = depth === 0 && lower.startsWith('dashboards/') ? entry.slice('dashboards/'.length) : null;
      if (result === null) {
        // Nothing left in it: the entry goes.
        changed = true;
        held = (held ?? 0) + 0;
        if (owner) {
          walk.bundlesDropped++;
          walk.droppedOwners.add(owner);
          walk.leftByOwner.set(owner, 0);
        }
        continue;
      }
      if (walk.removed !== before) changed = true;
      if (result.left !== null) {
        held = (held ?? 0) + result.left;
        if (owner) walk.leftByOwner.set(owner, result.left);
      }
      out[entry] = result.bytes;
    }
    if (held === 0 && depth > 0) return null;
    if (!changed) return { bytes, left: held };
    // A dropped owner's sharing entry goes with its bundle.
    for (const owner of walk.droppedOwners) delete out[`dashboardsharings/${owner}`];
    if (depth === 0 && out['configuration.json']) out['configuration.json'] = recount(out['configuration.json'], walk);
    return { bytes: await zip(out, new Date(), { keepOrder: true, compress: true }), left: held };
  }
  const raw = decoder.decode(bytes);
  const text = stripBom(raw);
  if (!text.trimStart().startsWith('{')) return { bytes, left: null };
  const here = walk.removals.filter((r) => r.file === where);
  const result = removeFromDashboardJson(text, (d) => walk.removals.some((r) => r.id === String(d['id'] ?? '') && (here.includes(r) || same(r.json, d))));
  if (result.removed === 0) return { bytes, left: dashboardsSpan(text) ? result.left : null };
  walk.removed += result.removed;
  if (result.left === 0) return null;
  return { bytes: encoder.encode((raw.length !== text.length ? '﻿' : '') + result.text), left: result.left };
}

/** configuration.json with the dashboard counts as they now are. */
function recount(bytes            , walk      )             {
  try {
    const text = decoder.decode(bytes);
    const config = JSON.parse(stripBom(text))                           ;
    const byOwner = Array.isArray(config['dashboardsByOwner']) ? (config['dashboardsByOwner']                                        ) : [];
    const next = byOwner
      .map((o) => (o.owner !== undefined && walk.leftByOwner.has(o.owner) ? { ...o, count: walk.leftByOwner.get(o.owner)  } : o))
      .filter((o) => (o.count ?? 0) > 0);
    if (Array.isArray(config['dashboardsByOwner'])) config['dashboardsByOwner'] = next;
    if (typeof config['dashboards'] === 'number') config['dashboards'] = next.reduce((n, o) => n + (o.count ?? 0), 0);
    const indent = /^\{\r?\n( +)"/.exec(text)?.[1]?.length ?? 3;
    return encoder.encode(JSON.stringify(config, null, indent));
  } catch {
    return bytes;
  }
}

/**
 * The export without the dashboards named. `name` is the file's name, as
 * readDashboardExports was given it (it starts every RawDashboardExport.file).
 */
export async function removeDashboards(name        , data            , removals                             )                       {
  const walk       = { removals, removed: 0, bundlesDropped: 0, droppedOwners: new Set(), leftByOwner: new Map() };
  const result = await rewrite(name, data, 0, walk);
  if (result === null) {
    // A single dashboard file with everything removed: an empty dashboards array.
    const text = stripBom(decoder.decode(data));
    const emptied = removeFromDashboardJson(text, () => true);
    return { bytes: looksLikeZip(data) ? data : encoder.encode(emptied.text), removed: walk.removed, bundlesDropped: walk.bundlesDropped };
  }
  return { bytes: result.bytes, removed: walk.removed, bundlesDropped: walk.bundlesDropped };
}

/**
 * Saving a page's settings to a file, and loading them back.
 *
 * The spec builder and the two generators are forms, and a form that took an
 * hour to fill in should not live only in a browser tab. Each page writes its
 * answers as one plain document — which page it belongs to, and the values —
 * in whichever of three formats suits where it is going:
 *
 *  - JSON, for tools;
 *  - YAML, for people who keep their settings next to their playbooks;
 *  - TXT, one `field = value` line per answer, for a ticket, an email or a
 *    diff, and for editing in Notepad without breaking anything.
 *
 * All three read back to exactly the same values. Reading goes by the file
 * name first and the content second, so a pasted file loads too.
 *
 * Credentials are never written: the pages strip them before they get here,
 * and `stripSecrets` is here so that stays true for any page that forgets.
 */

import { renderYaml,                } from '../ansible/yaml.js';
import { readYaml } from '../core/yaml-read.js';
import { isRecord, isSecretPath, parsePath, pathString, setAt,           } from '../editor/doc.js';

                                                     

export const SETTINGS_FORMATS                                                                         = [
  { value: 'json', label: 'JSON', extension: '.json' },
  { value: 'yaml', label: 'YAML', extension: '.yaml' },
  { value: 'txt', label: 'Text (field = value)', extension: '.txt' },
];

/** What every settings file carries, whatever the page. */
                                   
                                                                  
                        
                           
                           
                               
 

// ---------------------------------------------------------------------------
// TXT: one leaf per line
// ---------------------------------------------------------------------------

/** A value as TXT writes it: bare when it would read back as the same string, JSON otherwise. */
function encodeValue(value      )         {
  if (typeof value !== 'string') return JSON.stringify(value);
  const bare =
    value !== '' &&
    value === value.trim() &&
    !/[\n\r]/.test(value) &&
    !/^["[{]/.test(value) &&
    !/^(true|false|null)$/.test(value) &&
    !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value);
  return bare ? value : JSON.stringify(value);
}

function decodeValue(text        , line        )       {
  const t = text.trim();
  if (/^["[{]/.test(t) || /^(true|false|null)$/.test(t) || /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) {
    try {
      return JSON.parse(t)        ;
    } catch {
      throw new Error(`Line ${line}: ${t} is not a readable value.`);
    }
  }
  return t;
}

/** Every leaf, as `path = value`. Empty lists and groups are written, so they survive. */
export function toTxt(value      , header                    = [])         {
  const out = header.map((h) => `# ${h}`.trimEnd());
  const walk = (node      , path                     )       => {
    if (Array.isArray(node) && node.length > 0) node.forEach((v, i) => walk(v, [...path, i]));
    else if (isRecord(node) && Object.keys(node).length > 0) for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    else out.push(`${pathString(path)} = ${encodeValue(node)}`);
  };
  walk(value, []);
  return `${out.join('\n')}\n`;
}

export function fromTxt(text        )       {
  let doc       = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const at = line.indexOf(' = ');
    const eq = at >= 0 ? at : line.indexOf('=');
    if (eq <= 0) throw new Error(`Line ${i + 1}: expected field = value.`);
    const path = parsePath(line.slice(0, eq).trim());
    const rest = line.slice(eq + (at >= 0 ? 3 : 1));
    doc = setAt(doc, path, decodeValue(rest, i + 1));
  });
  return doc;
}

function looksLikeTxt(text        )          {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  return lines.length > 0 && lines.every((l) => /^\s*[^\s=:][^=]*?\s=\s/.test(l) || /^[\w.[\]"-]+=/.test(l.trim()));
}

// ---------------------------------------------------------------------------
// All three
// ---------------------------------------------------------------------------

export function formatFor(name        , text        )                 {
  if (/\.json$/i.test(name)) return 'json';
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  if (/\.txt$/i.test(name)) return 'txt';
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  return looksLikeTxt(text) ? 'txt' : 'yaml';
}

export function writeSettings(value      , format                , header                    = [])         {
  if (format === 'json') return `${JSON.stringify(value, null, 2)}\n`;
  if (format === 'yaml') return renderYaml(value             , { header: header.join('\n') || undefined });
  return toTxt(value, header);
}

export function readSettings(text        , name = '')       {
  const format = formatFor(name, text);
  if (format === 'json') return JSON.parse(text)        ;
  if (format === 'txt') return fromTxt(text);
  return (readYaml(text).documents[0] ?? null)        ;
}

/** Wrap values for `kind`, dated now. */
export function envelope(kind        , body                      )                   {
  return { kind, version: 1, savedAt: new Date().toISOString(), ...body };
}

/**
 * The file's body if it was written for `kind`; otherwise a sentence saying
 * what it is instead, for the page to show.
 */
export function openEnvelope(value      , kind        , describe                                   = {})                                                   {
  if (!isRecord(value)) return { error: 'That file holds no settings.' };
  const found = typeof value.kind === 'string' ? value.kind : undefined;
  if (found === kind) return { ok: value };
  if (found && found.startsWith('archtoolkit.')) {
    return { error: `That file was saved from ${describe[found] ?? found.replace('archtoolkit.', 'the ')} page, not this one.` };
  }
  return { error: 'That file was not saved from this page.' };
}

/** A copy with every secret-named field emptied. */
export function stripSecrets(value      , path                      = [])       {
  if (Array.isArray(value)) return value.map((v, i) => stripSecrets(v, [...path, i]));
  if (isRecord(value)) {
    const out                       = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretPath([...path, k]) && typeof v === 'string') continue;
      out[k] = stripSecrets(v, [...path, k]);
    }
    return out;
  }
  return value;
}

/** Names the pages use for each other's files, for the "saved from another page" message. */
export const SETTINGS_KINDS                                   = {
  'archtoolkit.vcf-spec-builder': 'the VCF spec builder',
  'archtoolkit.terraform-generator': 'the Terraform',
  'archtoolkit.ansible-generator': 'the Ansible',
};

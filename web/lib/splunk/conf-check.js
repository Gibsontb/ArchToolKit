/**
 * Reading Splunk `.conf` files the way splunkd does, and checking every
 * setting in them against Splunk's own `.conf.spec` files.
 *
 * Splunk is forgiving in exactly the wrong way: a misspelt setting, a setting
 * in the wrong stanza, or the same setting twice in one stanza is read without
 * an error, and the only symptom is that the change does nothing (or the last
 * copy quietly wins). `splunk btool check` finds some of it on a live node; this
 * finds it before the app is ever deployed, from the spec files alone.
 *
 * Used by tools/validate-splunk-blueprints.mjs, with the spec key sets cached
 * in conf-spec-data.ts by tools/fetch-splunk-specs.mjs.
 */

/** One `key = value` line (with its continuation lines folded in). */
                              
                       
                         
                                 
                        
 

/** A stanza, or the settings before the first stanza (`name` null). */
                             
                               
                        
                                   
 

                              
                        
                           
 

                             
                                 
                                   
 

/**
 * Parse a conf file.
 *
 * A line is a comment (`#`, after optional whitespace), blank, a stanza header
 * (`[name]`) or `key = value`. A value ending in a backslash continues on the
 * next line, whatever that line holds. Anything else is a problem, as is the
 * same key twice in one stanza (splunkd keeps the last and says nothing) and
 * the same stanza header twice in one file (the two are merged, which is never
 * what the second one meant).
 */
export function parseConf(text        )             {
  const lines = text.split(/\r?\n/);
  const stanzas               = [];
  const problems                = [];
  const byName = new Map                           ();
  let current             = { name: null, line: 0, settings: [] };
  byName.set(null, current);
  stanzas.push(current);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('[')) {
      if (!trimmed.endsWith(']')) {
        problems.push({ line: lineNo, message: `stanza header has no closing bracket: ${trimmed}` });
        continue;
      }
      const name = trimmed.slice(1, -1);
      const seen = byName.get(name);
      if (seen) {
        problems.push({ line: lineNo, message: `stanza [${name}] appears twice (first on line ${seen.line}); splunkd merges them` });
        current = seen;
        continue;
      }
      current = { name, line: lineNo, settings: [] };
      byName.set(name, current);
      stanzas.push(current);
      continue;
    }

    const eq = raw.indexOf('=');
    if (eq === -1) {
      problems.push({ line: lineNo, message: `not a stanza, a setting or a comment: ${trimmed.slice(0, 80)}` });
      continue;
    }
    const key = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1).trim();
    if (key === '') {
      problems.push({ line: lineNo, message: `setting with no key: ${trimmed.slice(0, 80)}` });
      continue;
    }
    // Continuation lines: a trailing backslash joins the next line to the value.
    while (value.endsWith('\\') && i + 1 < lines.length) {
      i++;
      value = `${value.slice(0, -1)}\n${lines[i].trim()}`;
    }
    const earlier = current.settings.find((s) => s.key === key);
    if (earlier) {
      const where = current.name === null ? 'outside any stanza' : `in [${current.name}]`;
      problems.push({ line: lineNo, message: `${key} is set twice ${where} (first on line ${earlier.line}); only the last one counts` });
    }
    current.settings.push({ key, value, line: lineNo });
  }
  return { stanzas, problems };
}

// --- The spec files ---------------------------------------------------------

/** One stanza of a spec file: its header pattern and the settings it lists. */
                             
                           
                                   
 

/**
 * What a `.conf.spec` file allows: the global settings (before the first
 * stanza, and under `[default]`), and each stanza pattern with its own.
 */
                           
                                     
                                          
 

/**
 * A setting line in a spec: at the start of the line, a key with no spaces
 * outside its `<placeholders>`, then `=`. Prose at column 0 that happens to
 * hold an `=` ("Example 1:  LINE_BREAKER = ...") has spaces, so is not one.
 */
function specKey(line        )                {
  if (/^[\s#*]/.test(line) || line.startsWith('[')) return null;
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const key = line.slice(0, eq).trim();
  if (key === '' || /\s/.test(key.replace(/<[^>]*>/g, 'X'))) return null;
  return key;
}

/** Read a `.conf.spec` file into its global settings and its stanza patterns. */
export function parseSpec(text        )           {
  const global = new Set        ();
  const stanzas = new Map                     ();
  let current                     = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('[') && line.endsWith(']')) {
      const pattern = line.slice(1, -1);
      if (pattern === 'default') {
        current = global;
        continue;
      }
      current = stanzas.get(pattern) ?? new Set        ();
      stanzas.set(pattern, current);
      continue;
    }
    const key = specKey(line);
    if (key !== null) (current ?? global).add(key);
  }
  return {
    global: [...global].sort(),
    stanzas: [...stanzas].map(([pattern, keys]) => ({ pattern, keys: [...keys].sort() })),
  };
}

/** Merge spec files that describe the same conf file (core, plus an app's own README/*.conf.spec). */
export function mergeSpecs(...specs                     )           {
  const global = new Set        ();
  const stanzas = new Map                     ();
  for (const spec of specs) {
    for (const k of spec.global) global.add(k);
    for (const s of spec.stanzas) {
      const set = stanzas.get(s.pattern) ?? new Set        ();
      for (const k of s.keys) set.add(k);
      stanzas.set(s.pattern, set);
    }
  }
  return { global: [...global].sort(), stanzas: [...stanzas].map(([pattern, keys]) => ({ pattern, keys: [...keys].sort() })) };
}

const escape = (s        )         => s.replace(/[.+?^${}()|\\]/g, '\\$&');

/**
 * A stanza pattern as a regular expression: `<anything>` and `*` match any
 * text (empty included, so `[tcp://<remote server>:<port>]` matches
 * `[tcp://:514]`), and literal brackets inside a pattern (the IPv6 form
 * `[splunktcp://[<remote server>]:<port>]`) are optional.
 */
export function stanzaRegex(pattern        )         {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '<') {
      const end = pattern.indexOf('>', i);
      if (end !== -1) {
        out += '.*';
        i = end;
        continue;
      }
    }
    if (c === '*') out += '.*';
    else if (c === '[') out += '\\[?';
    else if (c === ']') out += '\\]?';
    else out += escape(c);
  }
  return new RegExp(`^${out}$`, 's');
}

/**
 * A setting pattern as a regular expression: `<name>` and `*` match one or
 * more characters (`EXTRACT-<class>` needs a class; `remote.*` needs a rest).
 */
export function keyRegex(pattern        )         {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '<') {
      const end = pattern.indexOf('>', i);
      if (end !== -1) {
        out += '.+';
        i = end;
        continue;
      }
    }
    if (c === '*') out += '.+';
    else if (c === '[' || c === ']') out += `\\${c}`;
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

const isPattern = (key        )          => /[<*]/.test(key);

/** A key list, split into exact names and patterns, for fast matching. */
class KeySet {
           exact             ;
           patterns          ;
  constructor(keys                   ) {
    this.exact = new Set(keys.filter((k) => !isPattern(k)));
    this.patterns = keys.filter(isPattern).map(keyRegex);
  }
  has(key        )          {
    return this.exact.has(key) || this.patterns.some((p) => p.test(key));
  }
}

/** A spec prepared for matching. */
                               
                          
                                                                                                   
 

/** A pattern that is only a placeholder (`[<spec>]`, `[<stanza name>]`) accepts any stanza, and its keys are global in practice. */
const CATCH_ALL = /^(<[^>]*>|\*)$/;

export function compileSpec(spec          )               {
  return {
    global: new KeySet(spec.global),
    stanzas: spec.stanzas.map((s) => ({ pattern: s.pattern, regex: stanzaRegex(s.pattern), keys: new KeySet(s.keys), catchAll: CATCH_ALL.test(s.pattern) })),
  };
}

/**
 * Every stanza and setting in a parsed conf file that the spec does not have.
 *
 * A stanza must match one of the spec's stanza patterns (or be `[default]`).
 * A setting in a stanza must be a global setting or one listed under a
 * pattern that stanza matches. A setting outside any stanza, or in
 * `[default]`, is a default for every stanza, which splunkd accepts only for a
 * global setting or one from a catch-all stanza: `mode = manager` above
 * `[clustering]` in server.conf is read, and ignored.
 */
export function checkAgainstSpec(conf            , spec              , file        )                {
  const problems                = [];
  for (const stanza of conf.stanzas) {
    if (stanza.settings.length === 0 && stanza.name === null) continue;
    const isDefault = stanza.name === null || stanza.name === 'default';
    const matching = isDefault ? spec.stanzas.filter((s) => s.catchAll) : spec.stanzas.filter((s) => s.regex.test(stanza.name ?? ''));
    // A spec with no stanza headers at all (indexes.conf, workflow_actions.conf)
    // lists every setting globally and names its stanzas only in prose.
    if (!isDefault && matching.length === 0 && spec.stanzas.length > 0) {
      problems.push({ line: stanza.line, message: `[${stanza.name}] is not a stanza ${file} has` });
      continue;
    }
    for (const setting of stanza.settings) {
      if (spec.global.has(setting.key) || matching.some((s) => s.keys.has(setting.key))) continue;
      const where = stanza.name === null ? 'outside any stanza' : `in [${stanza.name}]`;
      const elsewhere = isDefault ? spec.stanzas.find((s) => s.keys.has(setting.key)) : undefined;
      problems.push({
        line: setting.line,
        message: elsewhere
          ? `${setting.key} ${where} is only a setting of [${elsewhere.pattern}] in ${file}; here it is ignored`
          : `${setting.key} is not a setting ${where} of ${file}`,
      });
    }
  }
  return problems;
}

// --- Which spec a file is ----------------------------------------------------

/**
 * The conf file a generated file is, by name: `default/inputs.conf` is
 * inputs.conf; a snippet with another name (`server-conf/cluster-manager.conf`)
 * says in its comments where it goes (`$SPLUNK_HOME/etc/system/local/server.conf`),
 * and the first known conf file named there is the one.
 */
export function confTypeOf(path        , text        , known                     )                {
  const base = path.split('/').pop() ?? path;
  if (base.endsWith('.meta')) return 'default.meta';
  if (known.has(base)) return base;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('#')) continue;
    for (const m of line.matchAll(/([A-Za-z_][\w-]*\.conf)\b/g)) if (known.has(m[1])) return m[1];
  }
  return null;
}

// --- Credentials -------------------------------------------------------------

/**
 * Settings that hold a secret, by name. An access key *id* (`remote.s3.access_key`,
 * Azure's storage account name in `remote.azure.access_key`) names the
 * account and is not one; its secret is `secret_key`. A literal AWS key id is
 * still caught by its shape below.
 */
const SECRET_KEY = /(password|passwd|pass4SymmKey|secret|secret_?key|token|api_?key|private_?key)$/i;
/** Values that are not a secret: empty, a placeholder, or a reference to one. */
const PLACEHOLDER = /^$|^<.*>$|^\$|^\{\{|REQUIRED|^\*+$|^(true|false|0|1)$/i;

/**
 * Anything in a generated file that looks like a credential written in
 * clear. A setting named like a secret must be empty or a placeholder; and in
 * any file, a private key, an AWS key id, a JSON web token, a Splunk or bearer
 * authorization header with a literal value, a `-auth user:password` with a
 * literal password, or a URL with a password in it.
 */
export function credentialProblems(path        , text        )                {
  const problems                = [];
  const isConf = /\.(conf|meta)$/.test(path);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (isConf && !trimmed.startsWith('#')) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (SECRET_KEY.test(key) && !PLACEHOLDER.test(value)) problems.push({ line: lineNo, message: `${key} is set to a literal value` });
      }
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) problems.push({ line: lineNo, message: 'a private key' });
    if (/\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(line)) problems.push({ line: lineNo, message: 'an AWS access key id' });
    if (/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./.test(line)) problems.push({ line: lineNo, message: 'a JSON web token' });
    if (/Authorization:\s*(Splunk|Bearer|Basic)\s+[A-Za-z0-9+/=_.-]{16,}/i.test(line)) problems.push({ line: lineNo, message: 'an authorization header with a literal credential' });
    if (/token["']?\s*[:=]\s*["']?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(line)) problems.push({ line: lineNo, message: 'a HEC token' });
    if (!isConf && /(password|passwd|secret_?key|client_?secret)["']?\s*[:=]\s*["'][^"'$<{%\s]{4,}["']/i.test(line)) problems.push({ line: lineNo, message: 'a quoted literal password or secret' });
    const auth = /-auth\s+['"]?([^\s:'"]+):([^\s'"]+)/.exec(line);
    if (auth && !/^[$<%{]/.test(auth[2])) problems.push({ line: lineNo, message: '-auth with a literal password' });
    const url = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:([^\s/@'"]+)@/i.exec(line);
    if (url && !/^[$<%{]/.test(url[1])) problems.push({ line: lineNo, message: 'a URL with a password in it' });
  });
  return problems;
}

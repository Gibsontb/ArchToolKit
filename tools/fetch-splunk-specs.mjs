#!/usr/bin/env node
/**
 * Refresh the Splunk setting names the Splunk validator checks against, from
 * Splunk's own `.conf.spec` files.
 *
 * Every conf file Splunk reads has a spec file (etc/system/README/*.conf.spec
 * in an installation) listing each stanza and each setting it accepts. The
 * lightest authoritative copy is the one Splunk publishes with its VS Code
 * extension, github.com/splunk/vscode-extension-splunk, spec_files/<version>/:
 * the README spec files of each Splunk Enterprise release, a few hundred KB,
 * against a 1 GB tarball. (AppInspect ships no spec files, only the list of
 * conf file names.)
 *
 *   npm run splunk:specs                    # the newest release there
 *   npm run splunk:specs -- --version 10.4  # a particular one
 *
 * It writes src/splunk/conf-spec-data.ts, which is committed so the check runs
 * offline, recording the release, the commit and the fetch date. Only the
 * names are kept: per conf file, its global settings and each stanza pattern
 * with its settings. The descriptions stay with Splunk.
 *
 * Needs git and network access to github.com. Nothing else.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../src/splunk/conf-check.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'splunk', 'conf-spec-data.ts');
const REPO = 'https://github.com/splunk/vscode-extension-splunk.git';
const DIR = 'spec_files';

/**
 * Stanza headers a spec file writes as a literal where it means a pattern,
 * each with the spec's own words for it. The literal is kept; the pattern is
 * added with the same settings.
 */
const STANZA_PATTERNS = {
  // "[provider] ... <provider> must follow the following syntax: provider://<unique-federated-provider-name>"
  'federated.conf': { provider: 'provider://<unique-federated-provider-name>' },
  // "[http://name]": one HEC token's stanza, as the example under it shows.
  'inputs.conf': { 'http://name': 'http://<name>' },
  // The auto-generated pools' stanzas; a pool you create is [lmpool:<name>],
  // and the spec says its "field descriptions are the same".
  'server.conf': { 'lmpool:auto_generated_pool_forwarder': 'lmpool:<pool_name>' },
};

const argv = process.argv.slice(2);
const at = argv.indexOf('--version');
const wanted = at === -1 ? null : argv[at + 1];

const into = mkdtempSync(join(tmpdir(), 'atk-splunk-spec-'));
const git = (...args) => execFileSync('git', args, { cwd: into, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
try {
  execFileSync('git', ['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', REPO, into], { stdio: 'inherit' });
  git('sparse-checkout', 'set', DIR);
  const commit = git('rev-parse', '--short', 'HEAD').trim();
  const root = join(into, DIR);

  const byVersion = (a, b) => {
    const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+(\.\d+)+$/.test(d.name))
    .map((d) => d.name)
    .sort(byVersion);
  const version = wanted ?? versions[versions.length - 1];
  if (!versions.includes(version)) throw new Error(`No spec files for ${version}; there are: ${versions.join(', ')}`);

  const dir = join(root, version);
  const files = readdirSync(dir).filter((n) => n.endsWith('.conf.spec') || n === 'default.meta.spec').sort();
  // The exact release the files came from, from their "#   Version 10.4.2" line.
  let release = version;
  const specs = {};
  let keys = 0;
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    const v = /^#\s+Version\s+(\S+)/m.exec(text);
    if (v && byVersion(v[1], release) > 0) release = v[1];
    let spec = parseSpec(text);
    if (name === 'default.meta.spec') {
      // Its stanzas are examples ([], [views], [views/index_status]); every
      // setting it names applies to any object stanza.
      spec = { global: [...new Set([...spec.global, ...spec.stanzas.flatMap((s) => s.keys)])].sort(), stanzas: [{ pattern: '*', keys: [] }] };
    }
    for (const [literal, pattern] of Object.entries(STANZA_PATTERNS[name.replace(/\.spec$/, '')] ?? {})) {
      const from = spec.stanzas.find((s) => s.pattern === literal);
      if (!from) throw new Error(`${name} no longer has [${literal}]; update STANZA_PATTERNS in ${fileURLToPath(import.meta.url)}`);
      spec = { ...spec, stanzas: [...spec.stanzas, { pattern, keys: from.keys }] };
    }
    keys += spec.global.length + spec.stanzas.reduce((n, s) => n + s.keys.length, 0);
    specs[name.replace(/\.spec$/, '')] = spec;
  }

  const today = new Date().toISOString().slice(0, 10);
  const body = `/**
 * Generated by tools/fetch-splunk-specs.mjs — do not edit by hand.
 * Run \`npm run splunk:specs\` to refresh.
 *
 * Per conf file: the settings allowed everywhere (global, including
 * [default]) and each stanza pattern with its own settings, read from
 * Splunk Enterprise ${release}'s .conf.spec files
 * (${REPO.replace(/\.git$/, '')}, ${DIR}/${version}, commit ${commit}, fetched ${today}).
 */

import type { ConfSpec } from './conf-check.ts';

export const SPLUNK_SPEC_SOURCE = ${JSON.stringify({ release, version, repo: REPO.replace(/\.git$/, ''), path: `${DIR}/${version}`, commit, fetched: today })} as const;

export const SPLUNK_CONF_SPECS: Readonly<Record<string, ConfSpec>> = {
${Object.entries(specs)
  .map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)},`)
  .join('\n')}
};
`;
  writeFileSync(OUT, body);
  console.log(`Wrote ${OUT}: ${files.length} spec files, ${keys} settings, Splunk Enterprise ${release} (commit ${commit}).`);
} finally {
  rmSync(into, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

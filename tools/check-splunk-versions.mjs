#!/usr/bin/env node
/**
 * Is there a Splunk release newer than the one the Splunk page writes for?
 *
 * The page targets Splunk Enterprise and Splunk Cloud Platform releases
 * (SPLUNK_TARGETS in src/splunk/splunk.ts), and the Splunk validator checks
 * against the Enterprise .conf.spec files in src/splunk/conf-spec-data.ts.
 * This reads Splunk's own pages for the latest of each:
 *   - Splunk Enterprise: the download page (its data-version attribute), and
 *     the release notes, which redirect to the current release's;
 *   - Splunk Cloud Platform: the release notes, which redirect to the
 *     current release's (10.5.2605 is 10.5, May 2026).
 *
 *   npm run splunk:versions
 *
 * A newer release is flagged, not failed: moving the page to it is a piece of
 * work (new settings, removed ones, new spec files via npm run splunk:specs),
 * not something an update run does on its own. It fails only when Splunk's
 * pages cannot be read at all, and then only with --strict.
 */

import { SPLUNK_TARGETS } from '../src/splunk/splunk.ts';
import { SPLUNK_SPEC_SOURCE } from '../src/splunk/conf-spec-data.ts';

const strict = process.argv.includes('--strict');
const UA = { 'user-agent': 'Mozilla/5.0 (ArchToolKit version check)' };

const PAGES = {
  enterpriseDownload: 'https://www.splunk.com/en_us/download/splunk-enterprise.html',
  enterpriseNotes: 'https://help.splunk.com/en/splunk-enterprise/release-notes-and-updates/release-notes',
  cloudNotes: 'https://help.splunk.com/en/splunk-cloud-platform/release-notes',
};

async function read(url) {
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return { url: res.url, text: await res.text() };
}

const parts = (v) => v.split('.').map(Number);
function newer(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}
const highest = (list) => list.reduce((best, v) => (best === null || newer(v, best) ? v : best), null);
const minor = (v) => v.split('.').slice(0, 2).join('.');

async function enterprise() {
  const found = [];
  try {
    const { text } = await read(PAGES.enterpriseDownload);
    found.push(...[...text.matchAll(/data-version="(\d+\.\d+\.\d+)"/g)].map((m) => m[1]));
    found.push(...[...text.matchAll(/splunk-(\d+\.\d+\.\d+)-[0-9a-f]{12}-/g)].map((m) => m[1]));
  } catch (err) {
    console.log(`  (the download page could not be read: ${err.message})`);
  }
  try {
    const { url, text } = await read(PAGES.enterpriseNotes);
    found.push(...[...`${url}\n${text}`.matchAll(/release-notes\/(\d+\.\d+)\//g)].map((m) => m[1]));
  } catch (err) {
    console.log(`  (the Enterprise release notes could not be read: ${err.message})`);
  }
  return highest(found);
}

async function cloud() {
  try {
    const { url, text } = await read(PAGES.cloudNotes);
    return highest([...`${url}\n${text}`.matchAll(/release-notes\/(\d+\.\d+\.\d{4})\b/g)].map((m) => m[1]));
  } catch (err) {
    console.log(`  (the Cloud release notes could not be read: ${err.message})`);
    return null;
  }
}

let unread = 0;
let flagged = 0;
const [ent, cld] = await Promise.all([enterprise(), cloud()]);

console.log(`  Splunk Enterprise: the page targets ${SPLUNK_TARGETS.enterprise}; the spec files are ${SPLUNK_SPEC_SOURCE.release}; the latest is ${ent ?? 'unknown'}.`);
if (!ent) unread++;
else if (newer(minor(ent), SPLUNK_TARGETS.enterprise)) {
  flagged++;
  console.log(`  NEWER: Splunk Enterprise ${ent} is out. Review its release notes, move the page to ${minor(ent)} and run npm run splunk:specs -- --version ${minor(ent)}.`);
} else if (newer(ent, SPLUNK_SPEC_SOURCE.release)) {
  console.log(`  Maintenance release ${ent} is newer than the spec files (${SPLUNK_SPEC_SOURCE.release}); npm run splunk:specs picks it up once the spec mirror has it.`);
}

console.log(`  Splunk Cloud Platform: the page targets ${SPLUNK_TARGETS.cloud}; the latest is ${cld ?? 'unknown'}.`);
if (!cld) unread++;
else if (newer(minor(cld), SPLUNK_TARGETS.cloud)) {
  flagged++;
  console.log(`  NEWER: Splunk Cloud Platform ${cld} is out. Review its release notes (ACS changes first) and move the page to ${minor(cld)}.`);
}

console.log(flagged ? `\n  ${flagged} newer release${flagged > 1 ? 's' : ''} flagged — nothing fails because of it.` : unread ? '' : '\n  The page targets the latest releases.');
process.exit(strict && unread ? 1 : 0);

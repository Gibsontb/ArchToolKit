/**
 * ArchPad's tools as menu commands. Filled in by the tools module; the core adds them to the menus.
 *
 * Every command works on the selection when there is one and on the whole
 * document when there is not, the way Notepad++'s plugins do. Conversions
 * that change the kind of text (JSON to YAML, extracting addresses) open a
 * new tab instead of replacing, so the source is never lost to a misclick.
 * The pure work lives in the sibling modules, which have their own tests;
 * this file only wires them to CommandContext.
 */

                                                           
import { openCalculator } from '../../ui/net-calc.js';
import { describeIPv6, describeSubnet } from '../../core/net-calc.js';
import { formatJson, jsonToCsv, jsonToYaml, minifyJson, sortJsonKeys, validateJson, yamlToJson,                 } from './json.js';
import { decodeEntities, encodeEntities, formatXml, minifyXml, validateXml } from './xml.js';
import {
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  decodeJwt,
  hexDecode,
  hexEncode,
  qpDecode,
  qpEncode,
  rot13,
  urlDecodeComponent,
  urlDecodeForm,
  urlDecodeFull,
  urlEncodeComponent,
  urlEncodeFull,
} from './encode.js';
import { allHashes, crc32, md5, sha,              } from './hash.js';
import { addLineNumbers, convertTimestamp, ESCAPE_STYLES, escapeText, loremIpsum, removeLineNumbers, textStats, unescapeText, uuidV4, wrapLines } from './text.js';
import { findMatches, parsePattern, regexReplace } from './regex.js';
import {
  findCidrs,
  findEmails,
  findIPv4,
  findIPv6,
  findMacs,
  findUrls,
  rewriteIPv6,
  sortLinesByIp,
  uniqueSorted,
  uniqueSortedIps,
  validateIpLines,
} from './network.js';
import { decodeType7, findType7, maskSecrets } from './config.js';
import { grid, heading, note, pre, stack, table,          } from './panel.js';

// --- Wiring helpers -----------------------------------------------------------------

/** The selection, or the whole document when nothing is selected. */
function target(ctx                )                                                    {
  const sel = ctx.getSelection();
  return sel ? { text: sel, scope: 'selection' } : { text: ctx.getText(), scope: 'document' };
}

const errorText = (e         )         => (e instanceof Error ? e.message : String(e));

/** Run a tool and put any failure in the status bar rather than an uncaught exception. */
function guard(run                                               )                                         {
  return async (ctx) => {
    try {
      await run(ctx);
    } catch (e) {
      ctx.notify(errorText(e), 'error');
    }
  };
}

/** Replace the selection (or document) with fn(text). */
function transform(fn                          , done         )                                         {
  return guard((ctx) => {
    const { text } = target(ctx);
    if (!text) {
      ctx.notify('Nothing to work on: the document is empty.', 'error');
      return;
    }
    const out = fn(text);
    ctx.replaceSelection(out, { wholeWhenEmpty: true });
    if (done) ctx.notify(done);
  });
}

/** Open fn(text) in a new tab. */
function toNewTab(name        , language                    , fn                          )                                         {
  return guard((ctx) => {
    const out = fn(target(ctx).text);
    ctx.newDocument(name, out, language);
  });
}

function cmd(id        , label        , menu                 , group                    , run                , shortcut         )          {
  return { id: `tools.${id}`, label, menu, ...(group ? { group } : {}), ...(shortcut ? { shortcut } : {}), run };
}

// --- JSON ----------------------------------------------------------------------------

const JSON_GROUP = 'JSON';
const jsonCommands            = [
  cmd('json.format2', 'Format (2 spaces)', 'Tools', JSON_GROUP, transform((t) => formatJson(t, 2)), 'Ctrl+Alt+M'),
  cmd('json.format4', 'Format (4 spaces)', 'Tools', JSON_GROUP, transform((t) => formatJson(t, 4))),
  cmd('json.formatTab', 'Format (tabs)', 'Tools', JSON_GROUP, transform((t) => formatJson(t, '\t'))),
  cmd('json.minify', 'Minify', 'Tools', JSON_GROUP, transform(minifyJson)),
  cmd(
    'json.validate',
    'Validate',
    'Tools',
    JSON_GROUP,
    guard((ctx) => {
      const { text, scope } = target(ctx);
      const problem = validateJson(text);
      if (problem) ctx.notify(`Invalid JSON at line ${problem.line}, column ${problem.column}${scope === 'selection' ? ' of the selection' : ''}: ${problem.message}`, 'error');
      else ctx.notify(`Valid JSON (${scope}).`);
    }),
  ),
  cmd('json.sortKeys', 'Sort keys', 'Tools', JSON_GROUP, transform((t) => sortJsonKeys(t, detectIndent(t)))),
  cmd('json.toYaml', 'JSON to YAML (new tab)', 'Tools', JSON_GROUP, toNewTab('converted.yaml', 'yaml', jsonToYaml)),
  cmd('json.fromYaml', 'YAML to JSON (new tab)', 'Tools', JSON_GROUP, toNewTab('converted.json', 'json', (t) => yamlToJson(t, 2))),
  cmd('json.toCsv', 'JSON to CSV (new tab)', 'Tools', JSON_GROUP, toNewTab('converted.csv', undefined, jsonToCsv)),
];

/** Keep the file's own indentation when re-writing it (sort keys). */
function detectIndent(text        )             {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  return m[1] .startsWith('\t') ? '\t' : m[1] .length >= 4 ? 4 : 2;
}

// --- XML / HTML -------------------------------------------------------------------------

const XML_GROUP = 'XML';
const xmlCommands            = [
  cmd('xml.format', 'Format (pretty print)', 'Tools', XML_GROUP, transform((t) => formatXml(t)), 'Ctrl+Alt+Shift+B'),
  cmd('xml.minify', 'Minify (linearize)', 'Tools', XML_GROUP, transform(minifyXml)),
  cmd(
    'xml.validate',
    'Validate (well-formed)',
    'Tools',
    XML_GROUP,
    guard((ctx) => {
      const { text, scope } = target(ctx);
      const problem = validateXml(text);
      if (problem) ctx.notify(`Invalid XML${scope === 'selection' ? ' in the selection' : ''} — ${problem.message}`, 'error');
      else ctx.notify(`Well-formed XML (${scope}).`);
    }),
  ),
  cmd('html.encode', 'HTML entities: encode', 'Tools', XML_GROUP, transform((t) => encodeEntities(t))),
  cmd('html.encodeAll', 'HTML entities: encode, non-ASCII too', 'Tools', XML_GROUP, transform((t) => encodeEntities(t, true))),
  cmd('html.decode', 'HTML entities: decode', 'Tools', XML_GROUP, transform(decodeEntities)),
];

// --- Encode / decode -----------------------------------------------------------------------

const ENC_GROUP = 'Encode / Decode';

function showJwt(ctx                , token        )       {
  const jwt = decodeJwt(token);
  const rows        = [
    { name: 'Algorithm', value: String(jwt.header.alg ?? '(none)') },
    ...jwt.dates.map((d) => ({ name: d.claim, value: `${d.iso} (${d.epoch})`, warn: d.claim === 'exp' && jwt.expired === true })),
  ];
  if (jwt.expired !== null) rows.push({ name: 'Status', value: jwt.expired ? 'Expired' : 'Not expired', warn: jwt.expired });
  ctx.showPanel(
    'JWT',
    stack(
      table(rows),
      heading('Header'),
      pre(JSON.stringify(jwt.header, null, 2)),
      heading('Payload'),
      pre(JSON.stringify(jwt.payload, null, 2)),
      note(jwt.signature ? 'The signature is shown undecoded and has not been verified.' : 'No signature (an unsecured token).', 'warn'),
    ),
  );
}

const encodeCommands            = [
  cmd('b64.encode', 'Base64 encode (UTF-8)', 'Tools', ENC_GROUP, transform(base64Encode)),
  cmd('b64.decode', 'Base64 decode (UTF-8)', 'Tools', ENC_GROUP, transform(base64Decode)),
  cmd('b64url.encode', 'Base64URL encode', 'Tools', ENC_GROUP, transform(base64UrlEncode)),
  cmd('b64url.decode', 'Base64URL decode', 'Tools', ENC_GROUP, transform(base64UrlDecode)),
  cmd('url.encodeComponent', 'URL encode (component)', 'Tools', ENC_GROUP, transform(urlEncodeComponent)),
  cmd('url.decodeComponent', 'URL decode (component)', 'Tools', ENC_GROUP, transform(urlDecodeComponent)),
  cmd('url.encodeFull', 'URL encode (full URL)', 'Tools', ENC_GROUP, transform(urlEncodeFull)),
  cmd('url.decodeFull', 'URL decode (full URL)', 'Tools', ENC_GROUP, transform(urlDecodeFull)),
  cmd('url.decodeForm', 'URL decode (form, + as space)', 'Tools', ENC_GROUP, transform(urlDecodeForm)),
  cmd('hex.encode', 'Text to hex (UTF-8)', 'Tools', ENC_GROUP, transform((t) => hexEncode(t))),
  cmd('hex.encodeSpaced', 'Text to hex, spaced', 'Tools', ENC_GROUP, transform((t) => hexEncode(t, ' '))),
  cmd('hex.decode', 'Hex to text (UTF-8)', 'Tools', ENC_GROUP, transform(hexDecode)),
  cmd('qp.encode', 'Quoted-printable encode', 'Tools', ENC_GROUP, transform(qpEncode)),
  cmd('qp.decode', 'Quoted-printable decode', 'Tools', ENC_GROUP, transform(qpDecode)),
  cmd('rot13', 'ROT13', 'Tools', ENC_GROUP, transform(rot13)),
  cmd(
    'jwt.decode',
    'JWT decode',
    'Tools',
    ENC_GROUP,
    guard((ctx) => {
      const { text } = target(ctx);
      // With no selection, the first thing in the document shaped like a JWT.
      const token = ctx.getSelection() || /eyJ[\w-]*\.[\w-]+\.?[\w-]*/.exec(text)?.[0] || text;
      showJwt(ctx, token);
    }),
  ),
];

// --- Hashes ---------------------------------------------------------------------------------

const HASH_GROUP = 'Hash';

function hashPanel(ctx                , rows                                            , scope        , bytes        )       {
  ctx.showPanel(
    'Hashes',
    stack(
      table(rows.map((r) => ({ name: r.name, value: r.value, copy: /^[0-9a-f]+$/.test(r.value) }))),
      note(`Of the ${scope} as UTF-8 (${bytes.toLocaleString()} bytes), with the editor's line endings.`),
    ),
  );
}

const hashOne = (name        , fn                                            )          =>
  cmd(
    `hash.${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    name,
    'Tools',
    HASH_GROUP,
    guard(async (ctx) => {
      const { text, scope } = target(ctx);
      hashPanel(ctx, [{ name, value: await fn(text) }], scope, new TextEncoder().encode(text).length);
    }),
  );

const hashCommands            = [
  cmd(
    'hash.all',
    'All hashes',
    'Tools',
    HASH_GROUP,
    guard(async (ctx) => {
      const { text, scope } = target(ctx);
      hashPanel(ctx, await allHashes(text), scope, new TextEncoder().encode(text).length);
    }),
  ),
  hashOne('MD5', md5),
  ...(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']             ).map((n) => hashOne(n, (t) => sha(n, t))),
  hashOne('CRC32', crc32),
];

// --- Text -------------------------------------------------------------------------------------

const TEXT_GROUP = 'Text';

async function askNumber(ctx                , label        , initial        , min        , max        )                         {
  const answer = await ctx.prompt(label, String(initial));
  if (answer === null) return null;
  const n = Number(answer.trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Enter a whole number from ${min} to ${max}.`);
  return n;
}

const textCommands            = [
  cmd(
    'text.stats',
    'Word, character and line count',
    'Tools',
    TEXT_GROUP,
    guard((ctx) => {
      const { text, scope } = target(ctx);
      const s = textStats(text);
      ctx.showPanel(
        'Counts',
        stack(
          table([
            { name: 'Words', value: s.words.toLocaleString() },
            { name: 'Characters', value: s.characters.toLocaleString() },
            { name: 'Characters (no spaces)', value: s.charactersNoSpaces.toLocaleString() },
            { name: 'UTF-16 code units', value: s.utf16Units.toLocaleString() },
            { name: 'Bytes (UTF-8)', value: s.bytesUtf8.toLocaleString() },
            { name: 'Lines', value: s.lines.toLocaleString() },
            { name: 'Non-blank lines', value: s.nonBlankLines.toLocaleString() },
            { name: 'Paragraphs', value: s.paragraphs.toLocaleString() },
            { name: 'Longest line', value: `${s.longestLine.toLocaleString()} characters` },
          ]),
          note(`Of the ${scope}.`),
        ),
      );
    }),
  ),
  cmd('text.uuid', 'Insert UUID v4', 'Tools', TEXT_GROUP, guard((ctx) => ctx.replaceSelection(uuidV4()))),
  cmd('text.isoNow', 'Insert current date/time (ISO 8601, UTC)', 'Tools', TEXT_GROUP, guard((ctx) => ctx.replaceSelection(new Date().toISOString()))),
  cmd('text.epochNow', 'Insert current epoch (seconds)', 'Tools', TEXT_GROUP, guard((ctx) => ctx.replaceSelection(String(Math.floor(Date.now() / 1000))))),
  cmd(
    'text.timestamp',
    'Timestamp converter…',
    'Tools',
    TEXT_GROUP,
    guard(async (ctx) => {
      const sel = ctx.getSelection().trim();
      const input = await ctx.prompt('Epoch (s, ms, µs or ns) or a date', sel || String(Math.floor(Date.now() / 1000)));
      if (input === null) return;
      const t = convertTimestamp(input);
      ctx.showPanel(
        'Timestamp',
        stack(
          table([
            { name: 'Input', value: `${t.input} (read as ${t.readAs})` },
            { name: 'ISO 8601 (UTC)', value: t.isoUtc, copy: true },
            { name: 'Local', value: t.local, copy: true },
            { name: 'Epoch seconds', value: String(t.seconds), copy: true },
            { name: 'Epoch milliseconds', value: String(t.ms), copy: true },
            { name: 'Relative', value: t.relative },
          ]),
        ),
      );
    }),
  ),
  cmd(
    'text.lorem',
    'Insert lorem ipsum…',
    'Tools',
    TEXT_GROUP,
    guard(async (ctx) => {
      const n = await askNumber(ctx, 'Paragraphs', 3, 1, 200);
      if (n !== null) ctx.replaceSelection(loremIpsum(n));
    }),
  ),
  cmd(
    'text.addLineNumbers',
    'Add line numbers…',
    'Tools',
    TEXT_GROUP,
    guard(async (ctx) => {
      const start = await askNumber(ctx, 'Start at', 1, 0, 1e9);
      if (start === null) return;
      const { text } = target(ctx);
      ctx.replaceSelection(addLineNumbers(text, start), { wholeWhenEmpty: true });
    }),
  ),
  cmd('text.removeLineNumbers', 'Remove line numbers', 'Tools', TEXT_GROUP, transform(removeLineNumbers)),
  cmd(
    'text.wrap',
    'Wrap at N columns…',
    'Tools',
    TEXT_GROUP,
    guard(async (ctx) => {
      const width = await askNumber(ctx, 'Wrap at column', 80, 1, 10000);
      if (width === null) return;
      const { text } = target(ctx);
      ctx.replaceSelection(wrapLines(text, width), { wholeWhenEmpty: true });
    }),
  ),
];

const escapeCommands            = ESCAPE_STYLES.flatMap(({ id, label }) => [
  cmd(`escape.${id}`, `Escape: ${label}`, 'Tools', 'Escape / Unescape', transform((t) => escapeText(t, id))),
  cmd(`unescape.${id}`, `Unescape: ${label}`, 'Tools', 'Escape / Unescape', transform((t) => unescapeText(t, id))),
]);

// --- Regex tester -------------------------------------------------------------------------------

const regexCommand = cmd(
  'regex.tester',
  'Regex tester…',
  'Tools',
  undefined,
  guard(async (ctx) => {
    const pattern = await ctx.prompt('Pattern (JavaScript syntax; /pattern/flags also works)', '');
    if (!pattern) return;
    const literal = /^\/.*\/[a-z]*$/s.test(pattern);
    const flags = literal ? '' : await ctx.prompt('Flags (g global, i ignore case, m multiline, s dot-all, u unicode)', 'gm');
    if (flags === null) return;
    const re = parsePattern(pattern, flags);
    const { text, scope } = target(ctx);
    const { matches, truncated } = findMatches(text, re);
    const groupCount = Math.max(0, ...matches.map((m) => m.groups.length));
    const names = [...new Set(matches.flatMap((m) => Object.keys(m.named)))];
    const headers = ['#', 'Line:Col', 'Match', ...Array.from({ length: groupCount }, (_, i) => `$${i + 1}`), ...names.map((n) => `<${n}>`)];
    const rows = matches.map((m, i) => [String(i + 1), `${m.line}:${m.column}`, m.text, ...Array.from({ length: groupCount }, (_, g) => m.groups[g] ?? '—'), ...names.map((n) => m.named[n] ?? '—')]);
    ctx.showPanel(
      'Regex matches',
      stack(
        note(`${matches.length.toLocaleString()}${truncated ? '+' : ''} match${matches.length === 1 ? '' : 'es'} for ${re} in the ${scope}.${truncated ? ' Only the first 5,000 are listed.' : ''}`, truncated ? 'warn' : 'info'),
        matches.length ? grid(headers, rows) : null,
      ),
    );
    if (!matches.length) return;
    const replacement = await ctx.prompt('Replace each match with ($1, $<name>, $& allowed). Cancel to only list.', '');
    if (replacement === null) return;
    const result = regexReplace(text, re, replacement);
    ctx.replaceSelection(result.text, { wholeWhenEmpty: true });
    ctx.notify(`Replaced ${result.count.toLocaleString()} match${result.count === 1 ? '' : 'es'}.`);
  }),
);

// --- Network ------------------------------------------------------------------------------------

const extract = (id        , label        , name        , fn                            , sort                              )          =>
  cmd(
    `net.extract.${id}`,
    label,
    'Network',
    'Extract',
    guard((ctx) => {
      const { text, scope } = target(ctx);
      const found = sort(fn(text));
      if (!found.length) {
        ctx.notify(`None found in the ${scope}.`, 'error');
        return;
      }
      ctx.newDocument(name, `${found.join('\n')}\n`);
      ctx.notify(`${found.length.toLocaleString()} unique, sorted.`);
    }),
  );

function subnetRows(input        )        {
  if (input.includes(':')) {
    const d = describeIPv6(input.includes('/') ? input : `${input}/64`);
    if (typeof d === 'string') throw new Error(d);
    return [
      { name: 'Address', value: d.compressed, copy: true },
      { name: 'Expanded', value: d.expanded, copy: true },
      { name: 'Network', value: d.network, copy: true },
      { name: 'Last address', value: d.last, copy: true },
      { name: 'Prefix', value: `/${d.prefix}` },
      { name: '/64 subnets', value: d.subnets64 },
      { name: 'Kind', value: d.kind },
    ];
  }
  const d = describeSubnet(input);
  if (typeof d === 'string') throw new Error(d);
  return [
    { name: 'CIDR', value: d.cidr, copy: true },
    { name: 'Address', value: d.address },
    { name: 'Network', value: d.network, copy: true },
    { name: 'Broadcast', value: d.broadcast },
    { name: 'Netmask', value: d.netmask, copy: true },
    { name: 'Wildcard', value: d.wildcard, copy: true },
    { name: 'First host', value: d.firstHost },
    { name: 'Last host', value: d.lastHost },
    { name: 'Usable hosts', value: d.usable.toLocaleString() },
    { name: 'Total addresses', value: d.total.toLocaleString() },
    { name: 'Kind', value: d.kind },
    { name: 'Reverse zone', value: d.reverseZone },
    { name: 'Next network', value: d.next ?? '(none — end of the address space)' },
    { name: 'Mask (binary)', value: d.binaryMask },
    ...(d.hostBitsSet ? [{ name: 'Note', value: `Host bits are set: ${d.address} is inside ${d.cidr}.`, warn: true }] : []),
  ];
}

const networkCommands            = [
  extract('ipv4', 'IPv4 addresses', 'ipv4.txt', findIPv4, uniqueSortedIps),
  extract('ipv6', 'IPv6 addresses', 'ipv6.txt', findIPv6, uniqueSortedIps),
  extract('ips', 'All IP addresses', 'ip-addresses.txt', (t) => [...findIPv4(t), ...findIPv6(t)], uniqueSortedIps),
  extract('cidrs', 'Networks (CIDR)', 'networks.txt', findCidrs, uniqueSortedIps),
  extract('macs', 'MAC addresses', 'mac-addresses.txt', findMacs, uniqueSorted),
  extract('urls', 'URLs', 'urls.txt', findUrls, uniqueSorted),
  extract('emails', 'Email addresses', 'emails.txt', findEmails, (l) => uniqueSorted(l.map((e) => e.toLowerCase()))),
  cmd('net.sort', 'Sort lines by IP (numeric)', 'Network', undefined, transform(sortLinesByIp, 'Sorted by address: IPv4, then IPv6, then other lines.')),
  cmd(
    'net.validate',
    'Validate lines as IP / CIDR',
    'Network',
    undefined,
    guard((ctx) => {
      const { text, scope } = target(ctx);
      const r = validateIpLines(text);
      if (!r.bad.length && !r.notes.length) {
        ctx.notify(`All ${r.checked.toLocaleString()} lines in the ${scope} are valid addresses or networks.`);
        return;
      }
      ctx.showPanel(
        'IP validation',
        stack(
          note(`${r.bad.length} bad of ${r.checked} checked lines in the ${scope}${r.notes.length ? `; ${r.notes.length} with notes` : ''}. Blank lines and # comments are skipped.`, r.bad.length ? 'warn' : 'info'),
          r.bad.length ? grid(['Line', 'Text', 'Problem'], r.bad.map((b) => [String(b.line), b.text, b.problem])) : null,
          r.notes.length ? heading('Notes') : null,
          r.notes.length ? grid(['Line', 'Text', 'Note'], r.notes.map((b) => [String(b.line), b.text, b.problem])) : null,
        ),
      );
      if (r.bad.length) ctx.notify(`${r.bad.length} invalid line${r.bad.length === 1 ? '' : 's'}.`, 'error');
    }),
  ),
  ...(['compress', 'expand']         ).map((mode) =>
    cmd(
      `net.ipv6.${mode}`,
      `IPv6: ${mode}`,
      'Network',
      undefined,
      guard((ctx) => {
        const { text } = target(ctx);
        const r = rewriteIPv6(text, mode);
        if (!r.count) {
          ctx.notify(`No IPv6 addresses to ${mode}.`);
          return;
        }
        ctx.replaceSelection(r.text, { wholeWhenEmpty: true });
        ctx.notify(`${r.count} address${r.count === 1 ? '' : 'es'} ${mode === 'compress' ? 'compressed' : 'expanded'}.`);
      }),
    ),
  ),
  cmd(
    'net.subnetInfo',
    'Subnet info for selection…',
    'Network',
    undefined,
    guard(async (ctx) => {
      let input = ctx.getSelection().trim();
      if (!input || input.includes('\n')) {
        const answer = await ctx.prompt('Network (10.1.2.0/24, 10.1.2.3 255.255.255.0, 2001:db8::/48)', input.split('\n')[0] ?? '');
        if (answer === null) return;
        input = answer.trim();
      }
      ctx.showPanel(`Subnet ${input}`, stack(table(subnetRows(input))));
    }),
  ),
  cmd('net.calculator', 'Network calculator…', 'Network', undefined, guard(() => openCalculator())),
];

// --- Config helpers ---------------------------------------------------------------------------------

const CONFIG_GROUP = 'Config';
const configCommands            = [
  cmd(
    'config.mask',
    'Mask passwords and secrets (new tab)',
    'Tools',
    CONFIG_GROUP,
    guard((ctx) => {
      const { text, scope } = target(ctx);
      const r = maskSecrets(text);
      if (!r.count) {
        ctx.notify(`No passwords or secrets recognised in the ${scope}. Check it by eye before sharing.`, 'error');
        return;
      }
      ctx.newDocument('masked.txt', r.text);
      ctx.notify(`${r.count} value${r.count === 1 ? '' : 's'} masked on ${r.lines.length} line${r.lines.length === 1 ? '' : 's'}. Masking is best effort: read it before you share it.`);
    }),
  ),
  cmd(
    'config.type7',
    'Decode Cisco type 7 passwords',
    'Tools',
    CONFIG_GROUP,
    guard((ctx) => {
      const sel = ctx.getSelection().trim();
      if (/^\d{2}[0-9A-Fa-f]{2,}$/.test(sel)) {
        const plain = decodeType7(sel);
        ctx.showPanel('Cisco type 7', stack(table([{ name: sel, value: plain, copy: true }]), note('Type 7 is obfuscation, not encryption. Prefer "secret" (type 8/9) on the device.', 'warn')));
        return;
      }
      const { text, scope } = target(ctx);
      const hits = findType7(text);
      if (!hits.length) {
        ctx.notify(`No type 7 values ("password 7 …", "key 7 …") in the ${scope}. Select a single value to decode it.`, 'error');
        return;
      }
      ctx.showPanel(
        'Cisco type 7',
        stack(
          grid(['Line', 'Decoded', 'Config line'], hits.map((h) => [String(h.line), h.decoded, h.context])),
          note('Type 7 is obfuscation, not encryption. Prefer "secret" (type 8/9) on the device.', 'warn'),
        ),
      );
    }),
  ),
];

export const TOOL_COMMANDS                     = [
  ...jsonCommands,
  ...xmlCommands,
  ...encodeCommands,
  ...hashCommands,
  ...textCommands,
  ...escapeCommands,
  regexCommand,
  ...configCommands,
  ...networkCommands,
];

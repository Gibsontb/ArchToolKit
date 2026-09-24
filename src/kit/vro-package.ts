/**
 * An Orchestrator package (.package), built in the browser.
 *
 * The package is the unit VCF Automation's Orchestrator imports in one go:
 * workflows, actions, configuration elements and resource elements, each
 * signed, with the signer's certificate inside. This writes exactly what
 * VMware's own Build Tools write (`vropkg`, typescript/vropkg/src/serialize/
 * flat.ts in github.com/vmware/build-tools-for-vmware-aria):
 *
 *   dunes-meta-inf                      package properties, UTF-8
 *   certificates/<subject>.cer          the self-signed certificate, DER
 *   elements/<id>/info                  element properties, UTF-8
 *   elements/<id>/categories            UTF-16BE with a byte-order mark
 *   elements/<id>/data                  UTF-16BE with a byte-order mark
 *                                       (a zip, for a resource element)
 *   elements/<id>/content-signature     signature over data
 *   signatures/<every path above>       signature over that file
 *
 * Signatures are MD5withRSA (PKCS#1 v1.5), as vropkg makes them. WebCrypto has
 * no MD5, so the digest is computed here and the RSA operation done with the
 * key's own parameters. The certificate is X.509 v1 with no email address —
 * Build Tools documents that an email in the subject makes the import fail.
 *
 * A fresh key and certificate are made for each download. Orchestrator asks
 * once whether to trust the publisher; that prompt is the check that you are
 * importing what you meant to.
 *
 * Validated against vropkg itself (Build Tools commit 4ca2f6a, September 2026):
 * vropkg's parser (parse/flat.ts) reads every element of a package built here
 * with the right type, id, name, category path, action params and script,
 * config description and resource attributes; and vropkg's serializer, given
 * what it parsed and the same key, writes byte-identical dunes-meta-inf, info,
 * categories, data and signature files. The only difference is the resource
 * element's inner zip container (vropkg deflates, this stores); its entries are
 * identical. What that established, and is kept here:
 *
 *   - pkg-name is "<name>-<version>": vropkg's parser splits the version off at
 *     the last "-", so a name without one comes back garbled. Orchestrator lists
 *     the package under that name.
 *   - pkg-id is the v5 UUID of "http://<pkg-name>.package" (URL namespace).
 *   - info holds type, signature-owner and id only.
 *   - element data is the compact form xmldoc writes (see compactXml).
 *
 * The page describes a package as ordinary text files under a folder whose
 * name ends in `.package` (see readPackageSpec), so it can be read and
 * reviewed before it is built.
 */

import { zip } from './archive.ts';

// --- the spec ---------------------------------------------------------------

export interface VroParamSpec {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
}

export interface VroActionSpec {
  readonly id: string;
  readonly module: string;
  readonly name: string;
  readonly resultType: string;
  readonly params: readonly VroParamSpec[];
  readonly script: string;
  readonly description?: string;
}

export interface VroWorkflowSpec {
  readonly id: string;
  readonly name: string;
  readonly categoryPath: string;
  /** The workflow XML, as the Orchestrator editor writes it. */
  readonly xml: string;
}

export interface VroConfigAttribute {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'SecureString' | 'Array/string';
  readonly value?: string | number | boolean | readonly string[];
  readonly description?: string;
}

export interface VroConfigSpec {
  readonly id: string;
  readonly name: string;
  readonly categoryPath: string;
  readonly description?: string;
  readonly attributes: readonly VroConfigAttribute[];
}

export interface VroResourceSpec {
  readonly id: string;
  readonly name: string;
  readonly categoryPath: string;
  readonly mimeType: string;
  readonly content: string;
}

export interface VroPackageSpec {
  /** Fully qualified, e.g. vcf.automation.tags.compliance */
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly workflows: readonly VroWorkflowSpec[];
  readonly actions: readonly VroActionSpec[];
  readonly configs: readonly VroConfigSpec[];
  readonly resources: readonly VroResourceSpec[];
}

// --- reading the spec from the page's text files ----------------------------

/**
 * The page writes a package as reviewable text:
 *
 *   package.json                                   { name, description, version }
 *   workflows/<category path>/<name>.xml           workflow XML (id inside)
 *   actions/<module>/<name>.js                     the action's script
 *   actions/<module>/<name>.json                   { id, resultType, params, description }
 *   config/<category path>/<name>.json             { id, description, attributes }
 *   resources/<category path>/<file name>          content; id from resources.json
 *   resources.json                                 { "<path>": { id, mimeType } }
 */
export function readPackageSpec(files: Readonly<Record<string, string>>): VroPackageSpec {
  const meta = JSON.parse(files['package.json'] ?? '{}') as { name?: string; description?: string; version?: string };
  if (!meta.name) throw new Error('package.json with a name is required');
  const resourceMeta = JSON.parse(files['resources.json'] ?? '{}') as Record<string, { id: string; mimeType?: string }>;
  const workflows: VroWorkflowSpec[] = [];
  const actions: VroActionSpec[] = [];
  const configs: VroConfigSpec[] = [];
  const resources: VroResourceSpec[] = [];

  for (const [path, content] of Object.entries(files)) {
    let m: RegExpExecArray | null;
    if ((m = /^workflows\/(.+)\/([^/]+)\.xml$/.exec(path))) {
      const id = /\sid="([^"]+)"/.exec(content)?.[1];
      if (!id) throw new Error(`${path}: the workflow has no id`);
      workflows.push({ id, name: m[2]!, categoryPath: m[1]!.replace(/\//g, '/'), xml: content });
    } else if ((m = /^actions\/([^/]+)\/([^/]+)\.js$/.exec(path))) {
      const side = JSON.parse(files[`actions/${m[1]}/${m[2]}.json`] ?? 'null') as Omit<VroActionSpec, 'module' | 'name' | 'script'> | null;
      if (!side) throw new Error(`${path}: actions/${m[1]}/${m[2]}.json is missing`);
      actions.push({ ...side, module: m[1]!, name: m[2]!, script: content });
    } else if ((m = /^config\/(.+)\/([^/]+)\.json$/.exec(path))) {
      const body = JSON.parse(content) as Omit<VroConfigSpec, 'name' | 'categoryPath'>;
      configs.push({ ...body, name: m[2]!, categoryPath: m[1]! });
    } else if ((m = /^resources\/(.+)\/([^/]+)$/.exec(path))) {
      const rel = path.slice('resources/'.length);
      const info = resourceMeta[rel];
      if (!info) throw new Error(`${path}: no entry in resources.json`);
      resources.push({ id: info.id, name: m[2]!, categoryPath: m[1]!, mimeType: info.mimeType ?? mimeOf(m[2]!), content });
    }
  }
  return { name: meta.name, description: meta.description ?? '', version: meta.version ?? '1.0.0', workflows, actions, configs, resources };
}

function mimeOf(name: string): string {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.xml')) return 'application/xml';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'application/x-yaml';
  if (name.endsWith('.csv')) return 'text/csv';
  return 'text/plain';
}

// --- encodings ----------------------------------------------------------------

const utf8 = new TextEncoder();

/** UTF-16BE with a byte-order mark, as Orchestrator stores element data. */
export function utf16be(text: string): Uint8Array {
  const withBom = `﻿${text}`;
  const out = new Uint8Array(withBom.length * 2);
  for (let i = 0; i < withBom.length; i++) {
    const code = withBom.charCodeAt(i);
    out[i * 2] = code >> 8;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

/** Attribute and text escaping, as xmldoc (which vropkg serializes with) writes it. */
function x(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');
}

/** xmlbuilder's escaping (vropkg writes dunes-meta-inf, info and categories with it). */
function xbAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
}
function xbText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

function cdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/**
 * Element data in the form vropkg leaves it: vropkg re-serializes every
 * workflow, action and configuration element through xmldoc with
 * `toString({ compressed: true })`, which drops the XML declaration and the
 * whitespace between tags, trims every CDATA section, and writes an element
 * whose only content was an empty CDATA as self-closing. Writing the same
 * form here makes our element data byte-identical to vropkg's for the same
 * input (checked against vropkg in the validation recorded in vro.test.ts).
 */
export function compactXml(xml: string): string {
  // An empty CDATA produces no node at all (sax emits nothing for it); one of
  // only whitespace survives as <![CDATA[]]>.
  const EMPTY = '\u0000';
  const parts = xml.replace(/^\s*<\?xml[^>]*\?>/, '').split(/(<!\[CDATA\[[\s\S]*?\]\]>)/);
  const out = parts
    .map((part, i) => {
      if (i % 2 === 0) return part.replace(/>\s+</g, '><').trim();
      const body = part.slice(9, -3);
      return body === '' ? EMPTY : `<![CDATA[${body.trim()}]]>`;
    })
    .join('');
  return out.replace(/<([A-Za-z][\w:.-]*)((?:\s[^<>]*?)?)>\u0000<\/\1>/g, '<$1$2/>').replace(/\u0000/g, '');
}

function properties(entries: Readonly<Record<string, string>>, standalone: boolean, comment: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"${standalone ? ' standalone="no"' : ''}?>` +
    '<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">' +
    `<properties><comment>${xbText(comment)}</comment>` +
    Object.entries(entries)
      .map(([key, value]) => `<entry key="${xbAttr(key)}">${xbText(value)}</entry>`)
      .join('') +
    '</properties>'
  );
}

function categoriesXml(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return `<categories>${parts.map((p) => `<category name="${xbAttr(p)}"><name>${cdata(p)}</name></category>`).join('')}</categories>`;
}

function actionXml(action: VroActionSpec, version: string): string {
  return (
    `<dunes-script-module name="${x(action.name)}" result-type="${x(action.resultType)}" api-version="6.0.0" id="${x(action.id)}" version="${x(version)}" allowed-operations="vef">` +
    // vropkg always writes the description, empty or not.
    `<description>${cdata(action.description ?? '')}</description>` +
    action.params.map((p) => `<param n="${x(p.name)}" t="${x(p.type)}">${cdata(p.description ?? '')}</param>`).join('') +
    `<script encoded="false">${cdata(action.script)}</script>` +
    '</dunes-script-module>'
  );
}

function configXml(config: VroConfigSpec, version: string): string {
  const att = (a: VroConfigAttribute): string => {
    const desc = a.description ? `<description>${cdata(a.description)}</description>` : '';
    if (a.type === 'SecureString') return `<att name="${x(a.name)}" type="SecureString" read-only="false">${desc}</att>`;
    const raw =
      a.value === undefined || a.value === '' || (Array.isArray(a.value) && a.value.length === 0)
        ? '__NULL__'
        : a.type === 'number'
          ? Number(a.value).toFixed(1)
          : Array.isArray(a.value)
            ? `#{${a.value.map((v) => `#string#${v}#`).join(';')}}#`
            : String(a.value);
    return `<att name="${x(a.name)}" type="${x(a.type)}" read-only="false"><value encoded="n">${cdata(raw)}</value>${desc}</att>`;
  };
  return (
    `<config-element id="${x(config.id)}" version="${x(version)}">` +
    `<display-name>${cdata(config.name)}</display-name>` +
    (config.description ? `<description>${cdata(config.description)}</description>` : '') +
    `<atts>${config.attributes.map(att).join('')}</atts>` +
    '</config-element>'
  );
}

/** A workflow's data is its XML without the declaration, re-versioned to the package version, compacted. */
function workflowData(xml: string, version: string): string {
  return compactXml(xml).replace(/(<workflow\b[^>]*\sversion=")[^"]*(")/, `$1${x(version)}$2`);
}

// --- MD5 ------------------------------------------------------------------------

/** MD5, because vropkg signs with MD5withRSA and WebCrypto has no MD5. */
export function md5(data: Uint8Array): Uint8Array {
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const len = data.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]!) | (F >>> (32 - s[i]!)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

// --- RSA, DER and the certificate -------------------------------------------------

function big(b64url: string): bigint {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4));
  let hex = '';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return BigInt(`0x${hex || '0'}`);
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function bytesOfBig(value: bigint, length: number): Uint8Array {
  const hex = value.toString(16).padStart(length * 2, '0');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const MD5_DIGEST_INFO = [0x30, 0x20, 0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05, 0x05, 0x00, 0x04, 0x10];

export interface Signer {
  readonly subject: string;
  readonly certificate: Uint8Array;
  sign(data: Uint8Array): Uint8Array;
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return concat([new Uint8Array([tag, ...len]), body]);
}
const seq = (...p: Uint8Array[]) => der(0x30, ...p);
const set = (...p: Uint8Array[]) => der(0x31, ...p);
const oid = (bytes: number[]) => der(0x06, new Uint8Array(bytes));
const utf8str = (s: string) => der(0x0c, utf8.encode(s));
const printable = (s: string) => der(0x13, utf8.encode(s));
function utcTime(d: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, '0');
  return der(0x17, utf8.encode(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
}
function integer(bytes: Uint8Array): Uint8Array {
  return der(0x02, bytes[0]! & 0x80 ? concat([new Uint8Array([0]), bytes]) : bytes);
}

/**
 * A fresh RSA-2048 key and a v1 self-signed certificate (C, O, OU, CN; no
 * email), and a signer that makes MD5withRSA signatures with it.
 */
export async function createSigner(commonName = 'ArchToolKit package signer', when = new Date()): Promise<Signer> {
  const subtle = globalThis.crypto.subtle;
  const pair = (await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  const n = big(jwk.n!), p = big(jwk.p!), q = big(jwk.q!), dp = big(jwk.dp!), dq = big(jwk.dq!), qi = big(jwk.qi!);
  const k = 256;

  const rdn = (type: number[], value: Uint8Array) => set(seq(oid(type), value));
  const name = seq(
    rdn([0x55, 0x04, 0x06], printable('XX')),
    rdn([0x55, 0x04, 0x0a], utf8str('ArchToolKit')),
    rdn([0x55, 0x04, 0x0b], utf8str('Generated')),
    rdn([0x55, 0x04, 0x03], utf8str(commonName)),
  );
  const sha256WithRsa = seq(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), der(0x05));
  const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
  const serial = globalThis.crypto.getRandomValues(new Uint8Array(8));
  serial[0] = serial[0]! & 0x7f;
  const tbs = seq(integer(serial), sha256WithRsa, name, seq(utcTime(when), utcTime(new Date(when.getTime() + 10 * 365 * 864e5))), name, spki);
  const tbsSig = new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, tbs as Uint8Array<ArrayBuffer>));
  const certificate = seq(tbs, sha256WithRsa, der(0x03, new Uint8Array([0]), tbsSig));

  return {
    // The subject string vropkg writes: shortName=value, joined with commas.
    subject: `C=XX,O=Automation,OU=Generated,CN=${commonName}`,
    certificate,
    sign(data: Uint8Array): Uint8Array {
      const t = concat([new Uint8Array(MD5_DIGEST_INFO), md5(data)]);
      const em = new Uint8Array(k);
      em[1] = 0x01;
      em.fill(0xff, 2, k - t.length - 1);
      em[k - t.length - 1] = 0x00;
      em.set(t, k - t.length);
      const m = BigInt(`0x${Array.from(em, (b) => b.toString(16).padStart(2, '0')).join('')}`);
      // CRT: m^d mod n from the prime factors.
      const m1 = modpow(m, dp, p);
      const m2 = modpow(m, dq, q);
      const h = (qi * (((m1 - m2) % p) + p)) % p;
      return bytesOfBig(m2 + h * q, k);
    },
  };
}

// --- the package ------------------------------------------------------------------

let session: Promise<Signer> | null = null;

/**
 * One signer for the whole page session, so the core library and the
 * automation package downloaded side by side (or in one zip) are signed by the
 * same certificate, and Orchestrator asks to trust the publisher once.
 */
export function sessionSigner(): Promise<Signer> {
  session ??= createSigner();
  return session;
}

/** Build the .package bytes from a spec. */
export async function buildVroPackage(spec: VroPackageSpec, signer?: Signer): Promise<Uint8Array> {
  const s = signer ?? (await sessionSigner());
  const version = spec.version;
  const files: [string, Uint8Array][] = [];

  // vropkg: pkg-name is "<group>.<artifact>-<version>" (its parser splits the
  // version off at the last "-", and garbles a name without one), and pkg-id
  // is the v5 UUID of "http://<pkg-name>.package" in the URL namespace.
  const pkgName = `${spec.name}-${version}`;
  files.push([
    'dunes-meta-inf',
    utf8.encode(
      properties(
        {
          'pkg-id': await uuidV5(`http://${pkgName}.package`, UUID_NAMESPACE_URL),
          'pkg-name': pkgName,
          'pkg-description': spec.description || '',
          'pkg-signer': s.subject,
          'pkg-owner': s.subject,
        },
        false,
        'UTF-16',
      ),
    ),
  ]);
  files.push([`certificates/${s.subject}.cer`, s.certificate]);

  // info carries exactly what vropkg writes: type, signature owner, id. The
  // name comes from the data (display-name, or the action's name attribute).
  const element = async (id: string, type: string, categories: string, data: Uint8Array) => {
    files.push([`elements/${id}/info`, utf8.encode(properties({ type, 'signature-owner': s.subject, id }, true, 'Exported from PSCoE o11n-convert'))]);
    files.push([`elements/${id}/categories`, utf16be(categories)]);
    files.push([`elements/${id}/data`, data]);
    files.push([`elements/${id}/content-signature`, s.sign(data)]);
  };

  for (const w of spec.workflows) {
    await element(w.id, 'Workflow', categoriesXml(w.categoryPath), utf16be(workflowData(w.xml, version)));
  }
  for (const a of spec.actions) {
    // An action's category is its dotted module, as one entry.
    await element(a.id, 'ScriptModule', `<categories><category name="${xbAttr(a.module)}"><name>${cdata(a.module)}</name></category></categories>`, utf16be(compactXml(actionXml(a, version))));
  }
  for (const c of spec.configs) {
    await element(c.id, 'ConfigurationElement', categoriesXml(c.categoryPath), utf16be(compactXml(configXml(c, version))));
  }
  for (const r of spec.resources) {
    // vropkg's order ("order is important for ZIP checksum"); an empty
    // attribute is left out, as vropkg leaves it out.
    const inner = await zip(
      {
        'VSO-RESOURCE-INF/attribute_id': r.id,
        'VSO-RESOURCE-INF/attribute_name': r.name,
        'VSO-RESOURCE-INF/attribute_version': version,
        'VSO-RESOURCE-INF/attribute_mimetype': r.mimeType,
        'VSO-RESOURCE-INF/attribute_allowedOperations': 'vef',
        'VSO-RESOURCE-INF/data': r.content,
      },
      undefined,
      { keepOrder: true },
    );
    await element(r.id, 'ResourceElement', categoriesXml(r.categoryPath), inner);
  }

  // Every file written so far gets a signature of its own under signatures/.
  const signed = files.map(([path, data]) => [`signatures/${path}`, s.sign(data)] as [string, Uint8Array]);
  return zip(Object.fromEntries([...files, ...signed]), undefined, { keepOrder: true });
}

const UUID_NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** RFC 4122 version-5 UUID (SHA-1), as the uuid package's v5 makes it. */
export async function uuidV5(name: string, namespace: string): Promise<string> {
  const ns = new Uint8Array(namespace.replace(/-/g, '').match(/../g)!.map((h) => parseInt(h, 16)));
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', concat([ns, utf8.encode(name)]) as Uint8Array<ArrayBuffer>));
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A stable UUID from a seed, so ids survive regeneration and re-import updates. */
export async function uuidFrom(seed: string): Promise<string> {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(seed)));
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

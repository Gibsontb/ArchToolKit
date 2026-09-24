/**
 * The Orchestrator packages: built, signed, and run.
 *
 *   - every script in every package is ES5 (Orchestrator's JavaScript);
 *   - every .package built from the blueprints' text files verifies: each file
 *     under signatures/ and each element's content-signature is MD5withRSA
 *     over the right bytes, by the certificate in the package;
 *   - the core library's guards run in the emulator against fake endpoints
 *     in another process, and never log a secret.
 *
 * vropkg itself (VMware Build Tools) cannot run here — it needs npm — so the
 * byte-for-byte comparison with it is recorded in src/kit/vro-package.ts
 * rather than repeated on every test run.
 */

import { after, before, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createVerify } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect } from '../../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../../kit/blueprint.ts';
import { buildVroPackage, readPackageSpec } from '../../kit/vro-package.ts';
import { automationFor } from '../blueprints/index.ts';
import { es5Problems, packagesIn, VroEmulator, type WorkflowRun } from '../../testing/vro-emulator.ts';
import { startFakeServer, type FakeRequest, type FakeRoute, type FakeServer } from '../../testing/fake-rest-server.ts';
import { CORE_ACTIONS, CORE_PACKAGE_DIR } from './core.ts';
import { toPackage } from './to-package.ts';

function build(id: string, overrides: BlueprintValues = {}): Record<string, string> {
  const blueprint = automationFor(id);
  if (!blueprint) throw new Error(`no blueprint ${id}`);
  return { ...blueprint.build({ ...defaultValues(blueprint), ...overrides }, id).files };
}

const has = (tool: string): boolean => {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
};
const CURL = has('curl');

/** Every line any run logged, for the secret check. */
function logText(run: WorkflowRun): string {
  return run.logs.map((line) => line.message).join('\n') + JSON.stringify(run.outputs) + (run.error ?? '');
}

// ---------------------------------------------------------------------------

describe('vro: packages are Orchestrator JavaScript', () => {
  it('flags what Rhino-era Orchestrator does not run, and not text inside strings or regexes', () => {
    expect(es5Problems('let a = 1;').length).toBe(1);
    expect(es5Problems('const a = 1;').length).toBe(1);
    expect(es5Problems('var f = (x) => x;').length).toBe(1);
    expect(es5Problems('var s = `x`;').length).toBe(1);
    expect(es5Problems('class A {}').length).toBeGreaterThan(0);
    expect(es5Problems('var a = [...b];').length).toBe(1);
    expect(es5Problems('for (var x of y) {}').length).toBe(1);
    expect(es5Problems('var s = "let x = () => `y`"; var r = /"let "/; // const z')).toEqual([]);
    expect(es5Problems('var x = ;').length).toBe(1);
  });

  it('every action and workflow script in the reference packages is ES5', () => {
    const problems: string[] = [];
    for (const files of [build('vcfa_approval_policy'), build('vcfa_cloud_template')]) {
      for (const [dir, pkg] of Object.entries(packagesIn(files))) {
        const spec = readPackageSpec(pkg);
        for (const a of spec.actions) problems.push(...es5Problems(a.script, `${dir}/${a.name}`));
        for (const w of spec.workflows) {
          const script = [...w.xml.matchAll(/<script encoded="false">((?:<!\[CDATA\[[\s\S]*?\]\]>)+)<\/script>/g)].map((m) => [...m[1]!.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((c) => c[1]).join(''));
          expect(script.length).toBe(1);
          problems.push(...es5Problems(script[0]!, `${dir}/${w.name}`));
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('every core action is in the core package, with a stable id', () => {
    const files = build('vcfa_approval_policy');
    for (const action of CORE_ACTIONS) {
      expect(typeof files[`${CORE_PACKAGE_DIR}/actions/com.archtoolkit.core/${action.name}.js`]).toBe('string');
      const side = JSON.parse(files[`${CORE_PACKAGE_DIR}/actions/com.archtoolkit.core/${action.name}.json`]!) as { id: string };
      expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(side.id)).toBe(true);
    }
    // The same core library in every automation, byte for byte.
    const other = build('vcfa_cloud_template');
    for (const [path, body] of Object.entries(files)) if (path.startsWith(`${CORE_PACKAGE_DIR}/`)) expect(other[path]).toBe(body);
  });

  it('refuses a package or element name Orchestrator would not take', () => {
    const spec = { packageName: 'com.archtoolkit.x', description: '', categoryPath: 'A/B', workflow: { name: 'W', description: '', inputs: [], outputs: [], script: '' }, config: { name: 'C', description: '', attributes: [] } };
    expect(() => toPackage({ ...spec, packageName: 'Com.Bad-Name' })).toThrow(/package name/);
    expect(() => toPackage({ ...spec, workflow: { ...spec.workflow, name: 'a/b' } })).toThrow(/has a "\/"/);
  });
});

// ---------------------------------------------------------------------------

/** The entries of a stored zip (the kind archive.ts writes). */
function unzipStored(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0) throw new Error(`${name} is compressed`);
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.set(name, bytes.subarray(dataAt, dataAt + size));
    at += 46 + nameLength + extra;
  }
  return out;
}

describe('vro: the .package files verify', () => {
  it('signs every file and every element with MD5withRSA by the certificate inside', async () => {
    const files = { ...build('vcfa_approval_policy'), ...build('vcfa_cloud_template') };
    const packages = packagesIn(files);
    expect(Object.keys(packages).length).toBe(3);
    for (const [dir, text] of Object.entries(packages)) {
      const spec = readPackageSpec(text);
      const entries = unzipStored(await buildVroPackage(spec));
      const cer = [...entries.keys()].find((name) => name.startsWith('certificates/'));
      expect(Boolean(cer)).toBe(true);
      const key = new X509Certificate(entries.get(cer!)!).publicKey;
      const signed = [...entries.keys()].filter((name) => !name.startsWith('signatures/'));
      let verified = 0;
      for (const name of signed) {
        const signature = entries.get(`signatures/${name}`);
        if (!signature) throw new Error(`${dir}: ${name} has no signature`);
        if (!createVerify('MD5').update(entries.get(name)!).verify(key, signature)) throw new Error(`${dir}: the signature of ${name} does not verify`);
        verified++;
        if (name.endsWith('/data')) {
          const content = entries.get(name.replace(/data$/, 'content-signature'))!;
          if (!createVerify('MD5').update(entries.get(name)!).verify(key, content)) throw new Error(`${dir}: the content-signature of ${name} does not verify`);
        }
      }
      // Every element: info, categories, data, content-signature.
      const elements = spec.workflows.length + spec.actions.length + spec.configs.length + spec.resources.length;
      expect(signed.filter((name) => name.startsWith('elements/')).length).toBe(elements * 4);
      expect(verified).toBe(signed.length);
      const meta = new TextDecoder().decode(entries.get('dunes-meta-inf'));
      expect(meta.includes(`<entry key="pkg-name">${spec.name}-${spec.version}</entry>`)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------

describe('vro: the core library guards', { skip: !CURL }, () => {
  const files = build('vcfa_approval_policy');
  const servers: FakeServer[] = [];
  after(() => servers.forEach((s) => s.stop()));
  const core = (emulator: VroEmulator) => emulator.module('com.archtoolkit.core') as Record<string, (...args: unknown[]) => unknown>;

  it('notify: a failed post names only the webhook host, never its path or query (regression)', async () => {
    const server = await startFakeServer([
      { method: 'POST', path: '^/services/T0001/', status: 500, body: { error: 'boom' } },
      { method: 'POST', path: '^/services/T0002/', body: {} },
    ]);
    servers.push(server);
    const host = `127.0.0.1:${server.port}`;
    const emulator = new VroEmulator(files);
    const failed = core(emulator).notify!(`https://${host}/services/T0001/B0002/path-token-do-not-log?key=query-do-not-log`, { a: 1 });
    expect(failed).toBe(false);
    const ok = core(emulator).notify!(`https://${host}/services/T0002/B0003/path-token-do-not-log`, '{"a":1}');
    expect(ok).toBe(true);
    // Nothing listens here: the connection error names the URL too.
    const refused = core(emulator).notify!('https://127.0.0.1:1/services/T0004/refused-token-do-not-log', { a: 1 });
    expect(refused).toBe(false);
    const text = emulator.logs.map((l) => l.message).join('\n');
    expect(text).toContain(`Webhook post to https://${host} failed`);
    expect(text).toContain('Webhook post to https://127.0.0.1:1 failed');
    expect(/do-not-log|T0001|T0004|\/services\//.test(text)).toBe(false);
    expect(server.requests().map((r) => r.path.split('?')[0])).toEqual(['/services/T0001/B0002/path-token-do-not-log', '/services/T0002/B0003/path-token-do-not-log']);
  });

  it('http: options.redact scrubs the URL in the error as well as the response', async () => {
    const server = await startFakeServer([{ method: 'GET', path: '^/x/', status: 403, body: { echo: '/x/secret-segment' } }]);
    servers.push(server);
    const emulator = new VroEmulator(files);
    expect(() => core(emulator).http!('GET', `https://127.0.0.1:${server.port}/x/secret-segment`, null, null, { redact: ['/x/secret-segment'] })).toThrow(/GET https:\/\/127\.0\.0\.1:\d+\*\*\*\* returned HTTP 403/);
    try {
      core(emulator).http!('GET', `https://127.0.0.1:${server.port}/x/secret-segment`, null, null, { redact: ['/x/secret-segment'] });
    } catch (e) {
      expect(String(e)).not.toContain('secret-segment');
    }
  });

  it('pageAll: refuses a page that starts with the same item as the page before, rather than loop (regression)', () => {
    const emulator = new VroEmulator(files);
    const pageAll = core(emulator).pageAll!;
    // An endpoint that ignores the page parameter: the same page for ever, no total.
    let calls = 0;
    expect(() =>
      pageAll(() => {
        calls++;
        return { items: [{ id: 'a' }, { id: 'b' }], total: null, more: null };
      }, 0),
    ).toThrow(/Page 1 starts with the same item as page 0 \(after 2 items\)/);
    expect(calls).toBe(2);
    // Items without ids compare by their JSON.
    expect(() => pageAll(() => ({ items: ['x', 'y'], total: null, more: null }), 0)).toThrow(/same item/);
    // Real pages still read whole, and a single page with more === false stops.
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []];
    // (JSON: the list is made in the scripts' own context.)
    expect(JSON.stringify(pageAll((page: number) => ({ items: pages[page], total: null, more: null }), 0))).toBe('[{"id":1},{"id":2},{"id":3}]');
    expect(JSON.stringify(pageAll(() => ({ items: [{ id: 1 }], total: null, more: false }), 0))).toBe('[{"id":1}]');
  });
});

describe('vro: webhook URLs are secrets in every automation', () => {
  it('every webhook-like attribute is a SecureString with no value, and IMPORT.md says to fill it (regression)', async () => {
    const { AUTOMATIONS } = await import('../blueprints/index.ts');
    const WEBHOOKISH = /webhook|auditurl|^endpoint$/i;
    const problems: string[] = [];
    let seen = 0;
    for (const blueprint of AUTOMATIONS) {
      const files = blueprint.build(defaultValues(blueprint), blueprint.id).files;
      for (const [dir, pkg] of Object.entries(packagesIn(files))) {
        if (dir === 'com.archtoolkit.core.package') continue;
        for (const config of readPackageSpec(pkg).configs) {
          for (const a of config.attributes) {
            if (!WEBHOOKISH.test(a.name)) continue;
            seen++;
            if (a.type !== 'SecureString') problems.push(`${blueprint.id}: ${a.name} is ${a.type}`);
            if (a.value !== undefined) problems.push(`${blueprint.id}: ${a.name} carries a value`);
            if (!(files['IMPORT.md'] ?? '').includes(`**${a.name}**`)) problems.push(`${blueprint.id}: IMPORT.md does not name ${a.name}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(seen).toBeGreaterThan(30);
  });
});

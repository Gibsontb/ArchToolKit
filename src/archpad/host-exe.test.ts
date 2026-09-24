import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { createExeHost, bytesToBase64, base64ToBytes, type WebViewBridge } from './host-exe.ts';

/**
 * A stand-in for window.chrome.webview. `sent` is what the page posted;
 * `reply` plays the C# side by dispatching a message back to the page.
 */
function fakeBridge() {
  const sent: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const bridge: WebViewBridge = {
    postMessage(message) {
      sent.push(message as Record<string, unknown>);
    },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
  };
  const reply = (data: unknown) => {
    for (const listener of listeners) listener({ data });
  };
  const lastRequest = () => [...sent].reverse().find((m) => m.kind === 'request')!;
  return { bridge, sent, reply, lastRequest };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const b64 = (s: string) => bytesToBase64(new TextEncoder().encode(s));

describe('archpad/host-exe: base64', () => {
  it('round-trips every byte value, including the ones text codecs would mangle', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });

  it('handles a buffer larger than one slice', () => {
    // The fallback encoder works in 32 KB slices; a file just over two of
    // them proves the seams join up.
    const bytes = new Uint8Array(70_001).map((_, i) => (i * 31) & 0xff);
    const back = base64ToBytes(bytesToBase64(bytes));
    expect(back.length).toBe(bytes.length);
    expect(back[70_000]).toBe(bytes[70_000]);
  });
});

describe('archpad/host-exe: requests', () => {
  it('says hello so the exe knows to ask before closing', () => {
    const { bridge, sent } = fakeBridge();
    createExeHost({ bridge, dropTarget: null });
    expect(sent[0]).toEqual({ kind: 'hello' });
  });

  it('opens files and decodes their bytes, inline and in partial batches', async () => {
    const { bridge, reply, lastRequest } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    const opening = host.openFiles();
    const req = lastRequest();
    expect(req.op).toBe('openFiles');
    reply({ kind: 'partial', id: req.id, files: [{ name: 'b.log', path: 'C:\\b.log', data: b64('two') }] });
    reply({ kind: 'response', id: req.id, ok: true, result: { files: [{ name: 'a.txt', path: 'C:\\a.txt', data: b64('one'), lastModified: 5 }] } });
    const files = await opening;
    expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.log']);
    expect(text(files[0]!.bytes)).toBe('one');
    expect(files[0]!.path).toBe('C:\\a.txt');
    expect(files[0]!.lastModified).toBe(5);
    expect(text(files[1]!.bytes)).toBe('two');
  });

  it('treats a cancelled dialog as an empty list', async () => {
    const { bridge, reply, lastRequest } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    const opening = host.openFiles();
    reply({ kind: 'response', id: lastRequest().id, ok: true, result: null });
    expect(await opening).toEqual([]);
  });

  it('sends save bytes as base64 with the path and returns where it landed', async () => {
    const { bridge, reply, lastRequest } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    const saving = host.save({ name: 'x.txt', path: 'D:\\x.txt', bytes: new TextEncoder().encode('hi\r\n') });
    const req = lastRequest();
    expect(req.op).toBe('save');
    expect(req.path).toBe('D:\\x.txt');
    expect(text(base64ToBytes(req.data as string))).toBe('hi\r\n');
    reply({ kind: 'response', id: req.id, ok: true, result: { name: 'x.txt', path: 'D:\\x.txt' } });
    expect(await saving).toEqual({ name: 'x.txt', path: 'D:\\x.txt' });
  });

  it('returns null from saveAs when the dialog is cancelled', async () => {
    const { bridge, reply, lastRequest } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    const saving = host.saveAs({ name: 'new 1', bytes: new Uint8Array() });
    expect(lastRequest().path).toBe(null);
    reply({ kind: 'response', id: lastRequest().id, ok: true, result: null });
    expect(await saving).toBe(null);
  });

  it('rejects with the exe error message (a read-only file, say)', async () => {
    const { bridge, reply, lastRequest } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    const saving = host.save({ name: 'r.txt', path: 'C:\\r.txt', bytes: new Uint8Array([1]) });
    reply({ kind: 'response', id: lastRequest().id, ok: false, error: 'Access to the path is denied.' });
    let message = '';
    try {
      await saving;
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Access to the path is denied.');
  });

  it('matches responses to requests by id when they overlap', async () => {
    const { bridge, reply, sent } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    const first = host.reload!({ path: 'C:\\1.txt' });
    const second = host.reload!({ path: 'C:\\2.txt' });
    const [r1, r2] = sent.filter((m) => m.kind === 'request');
    reply({ kind: 'response', id: r2!.id, ok: true, result: { name: '2.txt', path: 'C:\\2.txt', data: b64('two') } });
    reply({ kind: 'response', id: r1!.id, ok: true, result: { name: '1.txt', path: 'C:\\1.txt', data: b64('one') } });
    expect(text((await first)!.bytes)).toBe('one');
    expect(text((await second)!.bytes)).toBe('two');
  });

  it('collects a folder from partial batches', async () => {
    const { bridge, reply, lastRequest } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    const opening = host.openFolder();
    const id = lastRequest().id;
    reply({ kind: 'partial', id, files: [{ name: 'a', path: 'C:\\f\\a', data: b64('a') }] });
    reply({ kind: 'partial', id, files: [{ name: 'b', path: 'C:\\f\\sub\\b', data: b64('b') }] });
    reply({ kind: 'response', id, ok: true, result: { name: 'f' } });
    const folder = await opening;
    expect(folder!.name).toBe('f');
    expect(folder!.files.map((f) => f.path)).toEqual(['C:\\f\\a', 'C:\\f\\sub\\b']);
  });

  it('forwards the title', () => {
    const { bridge, sent } = fakeBridge();
    createExeHost({ bridge, dropTarget: null }).setTitle('*a.txt - ArchPad');
    expect(sent.at(-1)).toEqual({ kind: 'setTitle', title: '*a.txt - ArchPad' });
  });
});

describe('archpad/host-exe: messages from the exe', () => {
  it('queues files from the command line until the page is listening, then says ready', () => {
    const { bridge, sent, reply } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    reply({ kind: 'openRequest', files: [{ name: 'early.txt', path: 'C:\\early.txt', data: b64('e') }] });
    const got: string[] = [];
    host.onOpenRequest((files) => got.push(...files.map((f) => f.name)));
    expect(got).toEqual(['early.txt']);
    expect(sent.at(-1)).toEqual({ kind: 'ready' });
    reply({ kind: 'openRequest', files: [{ name: 'late.txt', data: b64('l') }] });
    expect(got).toEqual(['early.txt', 'late.txt']);
  });

  it('answers beforeClose with the handler verdict', async () => {
    const { bridge, sent, reply } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    host.onBeforeClose(async () => false);
    reply({ kind: 'beforeClose', id: 7 });
    await tick();
    expect(sent.at(-1)).toEqual({ kind: 'closeAnswer', id: 7, close: false });
  });

  it('lets the window close when no handler is registered', async () => {
    const { bridge, sent, reply } = fakeBridge();
    createExeHost({ bridge, dropTarget: null });
    reply({ kind: 'beforeClose', id: 1 });
    await tick();
    expect(sent.at(-1)).toEqual({ kind: 'closeAnswer', id: 1, close: true });
  });

  it('keeps the window open when the handler throws, so unsaved work survives', async () => {
    const { bridge, sent, reply } = fakeBridge();
    const host = createExeHost({ bridge, dropTarget: null });
    const original = console.error;
    console.error = () => {};
    try {
      host.onBeforeClose(() => {
        throw new Error('boom');
      });
      reply({ kind: 'beforeClose', id: 2 });
      await tick();
    } finally {
      console.error = original;
    }
    expect(sent.at(-1)).toEqual({ kind: 'closeAnswer', id: 2, close: false });
  });

  it('ignores junk and responses to unknown ids', () => {
    const { bridge, reply } = fakeBridge();
    createExeHost({ bridge, dropTarget: null });
    reply(null);
    reply('text');
    reply({ kind: 'response', id: 999, ok: true, result: null });
  });

  it('refuses to start outside the exe', () => {
    expect(() => createExeHost()).toThrow(/webview/);
  });
});

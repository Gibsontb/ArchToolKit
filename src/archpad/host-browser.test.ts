/**
 * The toolkit-to-ArchPad handoff.
 *
 * The parsing is what stands between a value in shared storage — which any
 * version of the toolkit, or a person with dev tools, may have written — and
 * the editor opening tabs, so it is tested against the malformed cases as
 * well as the good one. The channel protocol is tested with Node's own
 * BroadcastChannel, which behaves as the browser's does within one process.
 */

import { afterEach, describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  CHANNEL_NAME,
  HANDOFF_KEY,
  HANDOFF_MAX_AGE_MS,
  cleanFiles,
  makeHandoff,
  openInArchPad,
  parseHandoff,
  parseMessage,
  takeStoredHandoff,
} from './handoff.ts';
import { handoffToOpened } from './host-browser.ts';

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const g = globalThis as unknown as Record<string, unknown>;

function installStorage(): { local: MemoryStorage; session: MemoryStorage } {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  g.localStorage = local;
  g.sessionStorage = session;
  return { local, session };
}

afterEach(() => {
  delete g.localStorage;
  delete g.sessionStorage;
  delete g.open;
});

describe('parseHandoff', () => {
  const now = 1_800_000_000_000;

  it('reads the files the toolkit wrote', () => {
    const raw = JSON.stringify({ files: [{ name: 'main.tf', text: 'resource "x" "y" {}\n' }, { name: 'a.yml', text: '' }] });
    expect(parseHandoff(raw, now)).toEqual([
      { name: 'main.tf', text: 'resource "x" "y" {}\n' },
      { name: 'a.yml', text: '' },
    ]);
  });

  it('returns nothing for missing, malformed or non-object values', () => {
    expect(parseHandoff(null, now)).toEqual([]);
    expect(parseHandoff('', now)).toEqual([]);
    expect(parseHandoff('{not json', now)).toEqual([]);
    expect(parseHandoff('[1,2]', now)).toEqual([]);
    expect(parseHandoff('{"files":"nope"}', now)).toEqual([]);
  });

  it('drops entries without text and names the ones without a name', () => {
    const raw = JSON.stringify({ files: [{ name: 'x' }, 7, { text: 'hello' }, { name: '  ', text: 'b' }] });
    expect(parseHandoff(raw, now)).toEqual([
      { name: 'new 1', text: 'hello' },
      { name: 'new 2', text: 'b' },
    ]);
  });

  it('ignores a handoff older than the limit, keeps one inside it', () => {
    expect(parseHandoff(makeHandoff([{ name: 'a', text: 'x' }], now - HANDOFF_MAX_AGE_MS - 1), now)).toEqual([]);
    expect(parseHandoff(makeHandoff([{ name: 'a', text: 'x' }], now - 1000), now)).toEqual([{ name: 'a', text: 'x' }]);
  });

  it('keeps text exactly, including CRLF, tabs and non-ASCII', () => {
    const text = 'line1\r\n\tline2 é中😀\n';
    expect(parseHandoff(makeHandoff([{ name: 'n.txt', text }], now), now)).toEqual([{ name: 'n.txt', text }]);
  });
});

describe('parseMessage', () => {
  it('accepts the three message kinds', () => {
    expect(parseMessage({ type: 'ping', id: '1' })).toEqual({ type: 'ping', id: '1' });
    expect(parseMessage({ type: 'pong', id: '1', tab: 't' })).toEqual({ type: 'pong', id: '1', tab: 't' });
    expect(parseMessage({ type: 'open', id: '1', tab: 't', files: [{ name: 'a', text: 'b' }] })).toEqual({
      type: 'open',
      id: '1',
      tab: 't',
      files: [{ name: 'a', text: 'b' }],
    });
  });

  it('rejects anything else', () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage('ping')).toBeNull();
    expect(parseMessage({ type: 'ping' })).toBeNull();
    expect(parseMessage({ type: 'pong', id: '1' })).toBeNull();
    expect(parseMessage({ type: 'open', id: '1', tab: 't', files: [] })).toBeNull();
    expect(parseMessage({ type: 'other', id: '1' })).toBeNull();
  });
});

describe('cleanFiles', () => {
  it('returns [] for a non-array', () => {
    expect(cleanFiles({ name: 'a', text: 'b' })).toEqual([]);
  });
});

describe('handoffToOpened', () => {
  it('encodes text as UTF-8 bytes for the core to decode', () => {
    const [file] = handoffToOpened([{ name: 'u.txt', text: 'aé' }], 5);
    expect(file?.name).toBe('u.txt');
    expect([...(file?.bytes ?? [])]).toEqual([0x61, 0xc3, 0xa9]);
    expect(file?.lastModified).toBe(5);
    expect(file?.handle).toBeUndefined();
  });
});

describe('takeStoredHandoff', () => {
  it('reads from localStorage and clears both stores', () => {
    const { local, session } = installStorage();
    local.setItem(HANDOFF_KEY, makeHandoff([{ name: 'a', text: '1' }]));
    session.setItem(HANDOFF_KEY, makeHandoff([{ name: 'b', text: '2' }]));
    expect(takeStoredHandoff()).toEqual([{ name: 'a', text: '1' }]);
    expect(local.getItem(HANDOFF_KEY)).toBeNull();
    expect(session.getItem(HANDOFF_KEY)).toBeNull();
    expect(takeStoredHandoff()).toEqual([]);
  });

  it('works with no storage at all', () => {
    expect(takeStoredHandoff()).toEqual([]);
  });
});

describe('openInArchPad', () => {
  it('opens a new tab, with the files stored, when no ArchPad answers', async () => {
    const { local } = installStorage();
    const opened: string[] = [];
    g.open = (url: string) => {
      opened.push(url);
      return {};
    };
    expect(await openInArchPad([{ name: 'a.tf', text: 'x' }])).toBe('new');
    expect(opened).toEqual(['../app/archpad.html']);
    expect(parseHandoff(local.getItem(HANDOFF_KEY))).toEqual([{ name: 'a.tf', text: 'x' }]);
  });

  it('sends to the tab that answers, and only to it, and leaves nothing stored', async () => {
    const { local } = installStorage();
    g.open = () => {
      throw new Error('should not open a tab');
    };
    const received: unknown[] = [];
    const archpad = new BroadcastChannel(CHANNEL_NAME);
    archpad.onmessage = (event: MessageEvent) => {
      const msg = parseMessage(event.data);
      if (msg?.type === 'ping') archpad.postMessage({ type: 'pong', id: msg.id, tab: 'T1' });
      if (msg?.type === 'open') received.push(msg);
    };
    try {
      expect(await openInArchPad([{ name: 'b.yml', text: 'y' }])).toBe('tab');
      // The open message is delivered asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.length).toBe(1);
      expect((received[0] as { tab: string; files: unknown }).tab).toBe('T1');
      expect((received[0] as { files: unknown }).files).toEqual([{ name: 'b.yml', text: 'y' }]);
      expect(local.getItem(HANDOFF_KEY)).toBeNull();
    } finally {
      archpad.close();
    }
  });

  it('reports a blocked pop-up, and keeps the files for when ArchPad is opened by hand', async () => {
    const { local } = installStorage();
    g.open = () => null;
    expect(await openInArchPad([{ name: 'c', text: 'z' }])).toBe('blocked');
    expect(parseHandoff(local.getItem(HANDOFF_KEY))).toEqual([{ name: 'c', text: 'z' }]);
  });

  it('does nothing for no files', async () => {
    expect(await openInArchPad([])).toBe('nothing');
  });
});

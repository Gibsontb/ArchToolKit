/**
 * Handing generated files from the toolkit to ArchPad.
 *
 * A generator page and ArchPad are separate pages, often in separate tabs, so
 * there are two routes and the sender uses both:
 *
 *   1. A BroadcastChannel named 'archpad'. When an ArchPad tab is already
 *      open the files should land in it, not in yet another tab. The sender
 *      asks who is there (`ping`), the first tab to answer (`pong`) is told to
 *      open the files (`open`, addressed to that tab only) — so two open
 *      ArchPad tabs do not both open the same files.
 *   2. Storage under 'archtoolkit.archpad.handoff', read once by a freshly
 *      opened ArchPad. It goes in localStorage because a new tab does not share
 *      the opener's sessionStorage in every browser; ArchPad reads both.
 *
 * The payload is text, not bytes: generators produce strings, and JSON cannot
 * carry a Uint8Array. The browser host encodes to UTF-8 when it hands the
 * files to the editor.
 *
 * Parsing is kept pure and separate so it can be tested without a browser,
 * and so a malformed or stale entry (another version of the toolkit, a
 * hand-edited value) is dropped instead of opening garbage.
 */

export const HANDOFF_KEY = 'archtoolkit.archpad.handoff';
export const CHANNEL_NAME = 'archpad';
/** How long the sender waits for an open ArchPad tab before opening a new one. */
export const ANSWER_TIMEOUT_MS = 300;
/**
 * A handoff older than this is ignored. It exists for the tab that is about
 * to open; one left behind by a blocked pop-up should not surface next week.
 */
export const HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;
/** Guard against a pathological payload locking the editor up. */
const MAX_FILES = 500;

export interface HandoffFile {
  readonly name: string;
  readonly text: string;
}

export interface HandoffPayload {
  readonly files: readonly HandoffFile[];
  /** Milliseconds since the epoch; absent in hand-written payloads, which are then accepted. */
  readonly createdAt?: number;
}

export type ChannelMessage =
  | { readonly type: 'ping'; readonly id: string }
  | { readonly type: 'pong'; readonly id: string; readonly tab: string }
  | { readonly type: 'open'; readonly id: string; readonly tab: string; readonly files: readonly HandoffFile[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep only well-formed files; a bad name falls back to a numbered one rather than dropping the text. */
export function cleanFiles(value: unknown): HandoffFile[] {
  if (!Array.isArray(value)) return [];
  const out: HandoffFile[] = [];
  for (const item of value.slice(0, MAX_FILES)) {
    if (!isRecord(item) || typeof item.text !== 'string') continue;
    const raw = typeof item.name === 'string' ? item.name.trim() : '';
    out.push({ name: raw || `new ${out.length + 1}`, text: item.text });
  }
  return out;
}

/**
 * Read a stored handoff. Returns the files, or [] for anything missing,
 * malformed, empty or older than `HANDOFF_MAX_AGE_MS` relative to `now`.
 */
export function parseHandoff(raw: string | null | undefined, now: number = Date.now()): HandoffFile[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(data)) return [];
  if (typeof data.createdAt === 'number' && now - data.createdAt > HANDOFF_MAX_AGE_MS) return [];
  return cleanFiles(data.files);
}

/** Validate a message off the channel; anything else on it (another tool, a newer version) is ignored. */
export function parseMessage(data: unknown): ChannelMessage | null {
  if (!isRecord(data) || typeof data.id !== 'string') return null;
  switch (data.type) {
    case 'ping':
      return { type: 'ping', id: data.id };
    case 'pong':
      return typeof data.tab === 'string' ? { type: 'pong', id: data.id, tab: data.tab } : null;
    case 'open': {
      if (typeof data.tab !== 'string') return null;
      const files = cleanFiles(data.files);
      return files.length > 0 ? { type: 'open', id: data.id, tab: data.tab, files } : null;
    }
    default:
      return null;
  }
}

export function makeHandoff(files: readonly HandoffFile[], now: number = Date.now()): string {
  return JSON.stringify({ files: cleanFiles(files), createdAt: now } satisfies HandoffPayload);
}

export function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function storages(): Storage[] {
  const out: Storage[] = [];
  for (const get of [() => globalThis.localStorage, () => globalThis.sessionStorage]) {
    try {
      const s = get();
      if (s) out.push(s);
    } catch {
      // Storage throws in a private window or with site data blocked.
    }
  }
  return out;
}

/** Take (read and clear) the stored handoff from both stores, newest wins. */
export function takeStoredHandoff(now: number = Date.now()): HandoffFile[] {
  let files: HandoffFile[] = [];
  for (const s of storages()) {
    try {
      const got = parseHandoff(s.getItem(HANDOFF_KEY), now);
      s.removeItem(HANDOFF_KEY);
      if (files.length === 0) files = got;
    } catch {
      // Ignored: a handoff is a convenience.
    }
  }
  return files;
}

function clearStoredHandoff(): void {
  for (const s of storages()) {
    try {
      s.removeItem(HANDOFF_KEY);
    } catch {
      // Ignored.
    }
  }
}

/** Where ArchPad lives relative to the page doing the sending (every generator is in web/app/). */
export const ARCHPAD_URL = '../app/archpad.html';

/**
 * Send files to ArchPad: an open ArchPad tab if one answers in time, else a
 * new tab. Resolves with where they went. Call it from a click handler — the
 * new tab is opened within the click's user activation, which 300ms is well
 * inside.
 */
export async function openInArchPad(files: readonly HandoffFile[], url: string = ARCHPAD_URL): Promise<'tab' | 'new' | 'blocked' | 'nothing'> {
  const clean = cleanFiles(files);
  if (clean.length === 0) return 'nothing';

  // Stored first, so the new tab finds it however the channel goes.
  let stored = false;
  const payload = makeHandoff(clean);
  for (const s of storages()) {
    try {
      s.setItem(HANDOFF_KEY, payload);
      stored = true;
      break;
    } catch {
      // Quota or blocked storage: try the next one.
    }
  }

  const Channel = globalThis.BroadcastChannel;
  if (typeof Channel === 'function') {
    const channel = new Channel(CHANNEL_NAME);
    const id = randomId();
    const tab = await new Promise<string | null>((resolve) => {
      const timer = globalThis.setTimeout(() => resolve(null), ANSWER_TIMEOUT_MS);
      channel.onmessage = (event: MessageEvent) => {
        const msg = parseMessage(event.data);
        if (msg?.type === 'pong' && msg.id === id) {
          globalThis.clearTimeout(timer);
          resolve(msg.tab);
        }
      };
      channel.postMessage({ type: 'ping', id } satisfies ChannelMessage);
    });
    if (tab !== null) {
      channel.postMessage({ type: 'open', id, tab, files: clean } satisfies ChannelMessage);
      channel.close();
      // The open tab has them; a stored copy would reappear in the next new ArchPad tab.
      clearStoredHandoff();
      return 'tab';
    }
    channel.close();
  }

  if (!stored) {
    // No storage and no open tab: the new tab would open empty, so say so instead.
    return 'blocked';
  }
  const opened = globalThis.open?.(url, '_blank');
  return opened ? 'new' : 'blocked';
}

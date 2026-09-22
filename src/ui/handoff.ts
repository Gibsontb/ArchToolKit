/**
 * Passing work between the toolkit's pages.
 *
 * The three tools answer consecutive questions — what is there, what it needs to
 * become, and the document that builds it — but each page was an island, so the
 * only way across was to read numbers off one screen and retype them into the
 * next. This carries the structured result instead.
 *
 * `sessionStorage` is the right store here: it survives navigating between the
 * pages in a tab, and it goes away when the tab does, which is the correct
 * lifetime for a half-finished design. Nothing here is a system of record, and
 * a handoff is consumed once — `take` clears it — so reloading a page does not
 * silently re-apply a decision the user has since changed.
 *
 * Every access is wrapped: storage throws in a private window, with site data
 * blocked, and in some embedded views. A toolkit that fails to load because it
 * could not read an optional convenience would be a poor trade.
 */

export type HandoffKind =
  | 'inventory-to-sizing'
  | 'sizing-to-spec'
  | 'inventory-to-multicloud'
  | 'spec-to-editor';

/** Bumped when a payload shape changes, so a stale entry is discarded. */
const HANDOFF_VERSION = 1;

export interface Handoff<T> {
  readonly kind: HandoffKind;
  readonly version: number;
  readonly createdAt: string;
  /** Human description of where this came from, shown in the banner. */
  readonly origin: string;
  readonly payload: T;
}

function storageKey(kind: HandoffKind): string {
  return `archtoolkit.handoff.${kind}`;
}

function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Hand a payload to another page. Returns false when storage is unavailable. */
export function putHandoff<T>(kind: HandoffKind, origin: string, payload: T): boolean {
  const s = store();
  if (!s) return false;
  const entry: Handoff<T> = {
    kind,
    version: HANDOFF_VERSION,
    createdAt: new Date().toISOString(),
    origin,
    payload,
  };
  try {
    s.setItem(storageKey(kind), JSON.stringify(entry));
    return true;
  } catch {
    return false;
  }
}

function read<T>(kind: HandoffKind): Handoff<T> | null {
  const s = store();
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(storageKey(kind));
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Handoff<T>;
    // A payload written by an older build may not fit the current shape, and
    // half-applying it would be worse than ignoring it.
    if (parsed?.version !== HANDOFF_VERSION || parsed.kind !== kind) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Look without consuming, for deciding whether to offer the banner. */
export function peekHandoff<T>(kind: HandoffKind): Handoff<T> | null {
  return read<T>(kind);
}

/** Read and clear. A handoff applies once. */
export function takeHandoff<T>(kind: HandoffKind): Handoff<T> | null {
  const entry = read<T>(kind);
  const s = store();
  if (s) {
    try {
      s.removeItem(storageKey(kind));
    } catch {
      // Consuming is best-effort; the version check above still protects us.
    }
  }
  return entry;
}

export function clearHandoff(kind: HandoffKind): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(storageKey(kind));
  } catch {
    // Nothing to do; an unreadable store is already effectively empty.
  }
}

// ---------------------------------------------------------------------------
// The latest result, for a page that should follow it without being sent
// ---------------------------------------------------------------------------

/*
 * A handoff is sent by a button and consumed once. Some pages should also just
 * follow along: once sizing has an estate, the spec builder should open on it
 * without anyone pressing Continue. So sizing also records its latest result
 * here, and the spec builder applies it — once per result, so reloading the
 * spec builder does not overwrite edits made since with the same values.
 */

function latestKey(kind: HandoffKind): string {
  return `archtoolkit.latest.${kind}`;
}

function appliedKey(kind: string): string {
  return `archtoolkit.applied.${kind}`;
}

/** Record the latest result of a page, replacing the previous one. */
export function rememberLatest<T>(kind: HandoffKind, origin: string, payload: T): void {
  const s = store();
  if (!s) return;
  const entry: Handoff<T> = {
    kind,
    version: HANDOFF_VERSION,
    createdAt: new Date().toISOString(),
    origin,
    payload,
  };
  try {
    s.setItem(latestKey(kind), JSON.stringify(entry));
  } catch {
    // Following along is a convenience; losing it loses nothing else.
  }
}

/** The latest result, if there is one this page has not applied yet. */
export function unappliedLatest<T>(kind: HandoffKind): Handoff<T> | null {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(latestKey(kind));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Handoff<T>;
    if (entry?.version !== HANDOFF_VERSION || entry.kind !== kind) return null;
    return wasApplied(kind, entry.createdAt) ? null : entry;
  } catch {
    return null;
  }
}

/** Remember that a result — identified by a stamp — has been applied. */
export function markApplied(kind: string, stamp: string): void {
  try {
    store()?.setItem(appliedKey(kind), stamp);
  } catch {
    // As above.
  }
}

export function wasApplied(kind: string, stamp: string): boolean {
  try {
    return store()?.getItem(appliedKey(kind)) === stamp;
  } catch {
    return false;
  }
}

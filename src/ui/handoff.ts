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

export type HandoffKind = 'inventory-to-sizing' | 'sizing-to-spec';

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

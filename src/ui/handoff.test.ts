import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { putHandoff, peekHandoff, takeHandoff, clearHandoff } from './handoff.ts';

/** A minimal Storage stand-in; node has no sessionStorage. */
function installStorage(impl?: Partial<Storage>): Map<string, string> {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
    ...impl,
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: store,
    configurable: true,
    writable: true,
  });
  return data;
}

function removeStorage(): void {
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe('handoff between pages', () => {
  it('carries a payload across', () => {
    installStorage();
    expect(putHandoff('sizing-to-spec', 'four hosts', { hostCount: 4 })).toBe(true);
    expect(peekHandoff<{ hostCount: number }>('sizing-to-spec')?.payload.hostCount).toBe(4);
  });

  it('applies once — taking it clears it', () => {
    installStorage();
    putHandoff('sizing-to-spec', 'four hosts', { hostCount: 4 });
    expect(takeHandoff('sizing-to-spec')).toBeDefined();
    // Reloading the page must not silently re-apply a decision already used.
    expect(takeHandoff('sizing-to-spec')).toBeNull();
  });

  it('keeps the two directions separate', () => {
    installStorage();
    putHandoff('inventory-to-sizing', 'estate', { a: 1 });
    putHandoff('sizing-to-spec', 'sizing', { b: 2 });
    expect(takeHandoff('inventory-to-sizing')?.origin).toBe('estate');
    expect(takeHandoff('sizing-to-spec')?.origin).toBe('sizing');
  });

  it('records its origin for the banner', () => {
    installStorage();
    putHandoff('inventory-to-sizing', '42 hosts from RVTools', {});
    expect(peekHandoff('inventory-to-sizing')?.origin).toBe('42 hosts from RVTools');
  });
});

describe('handoff resilience', () => {
  it('ignores an entry written by an older version', () => {
    const data = installStorage();
    data.set(
      'archtoolkit.handoff.sizing-to-spec',
      JSON.stringify({ kind: 'sizing-to-spec', version: 0, payload: { hostCount: 99 } }),
    );
    // Half-applying a payload whose shape has changed is worse than ignoring it.
    expect(peekHandoff('sizing-to-spec')).toBeNull();
  });

  it('ignores an entry filed under the wrong kind', () => {
    const data = installStorage();
    data.set(
      'archtoolkit.handoff.sizing-to-spec',
      JSON.stringify({ kind: 'inventory-to-sizing', version: 1, payload: {} }),
    );
    expect(peekHandoff('sizing-to-spec')).toBeNull();
  });

  it('ignores unparseable content rather than throwing', () => {
    const data = installStorage();
    data.set('archtoolkit.handoff.sizing-to-spec', '{ not json');
    expect(peekHandoff('sizing-to-spec')).toBeNull();
  });

  it('survives storage being absent', () => {
    // Private windows and blocked site data both reach this path; the page must
    // still load.
    removeStorage();
    expect(putHandoff('sizing-to-spec', 'x', {})).toBe(false);
    expect(peekHandoff('sizing-to-spec')).toBeNull();
    expect(takeHandoff('sizing-to-spec')).toBeNull();
    clearHandoff('sizing-to-spec');
  });

  it('survives storage that throws on write', () => {
    installStorage({
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(putHandoff('sizing-to-spec', 'x', {})).toBe(false);
  });

  it('survives storage that throws on read', () => {
    installStorage({
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(peekHandoff('sizing-to-spec')).toBeNull();
  });
});

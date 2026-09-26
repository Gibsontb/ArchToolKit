import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { putHandoff, peekHandoff, takeHandoff, clearHandoff, HANDOFF_KINDS } from './handoff.ts';

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

describe('handoff from the Multi-Cloud Planner', () => {
  it('carries a Terraform settings envelope to the Terraform page', () => {
    installStorage();
    const envelope = {
      kind: 'archtoolkit.terraform-generator',
      version: 1,
      savedAt: '2026-09-26T00:00:00.000Z',
      target: 'aws',
      blueprint: 'mig_aws_landing_zone',
      values: {},
      stackName: 'plan-aws',
      stack: [{ id: 'lz', blueprintId: 'mig_aws_landing_zone', label: 'Landing zone', values: { name_prefix: 'plan-aws' } }],
    };
    expect(putHandoff('plan-to-terraform', 'Migration plan · AWS', envelope)).toBe(true);
    const got = takeHandoff<typeof envelope>('plan-to-terraform');
    expect(got?.origin).toBe('Migration plan · AWS');
    expect(got?.payload).toEqual(envelope);
    expect(takeHandoff('plan-to-terraform')).toBeNull();
  });

  it('carries an Ansible settings envelope to the Ansible page, separately', () => {
    installStorage();
    putHandoff('plan-to-terraform', 'tf', { kind: 'archtoolkit.terraform-generator' });
    putHandoff('plan-to-ansible', 'ansible', { kind: 'archtoolkit.ansible-generator', target: 'linux' });
    expect(takeHandoff<{ target: string }>('plan-to-ansible')?.payload.target).toBe('linux');
    expect(peekHandoff('plan-to-terraform')?.origin).toBe('tf');
  });

  it('lists every kind once, and no longer has the dead inventory-to-multicloud', () => {
    expect(new Set(HANDOFF_KINDS).size).toBe(HANDOFF_KINDS.length);
    expect(HANDOFF_KINDS).toContain('plan-to-terraform');
    expect(HANDOFF_KINDS).toContain('plan-to-ansible');
    expect(HANDOFF_KINDS).toContain('inventory-to-sizing');
    expect((HANDOFF_KINDS as readonly string[]).includes('inventory-to-multicloud')).toBe(false);
  });
});

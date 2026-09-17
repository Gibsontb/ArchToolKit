/**
 * A ~60-line `expect` shim over node:assert.
 *
 * The toolkit has no dependencies, so there is no Vitest or Jest here. Rather
 * than writing `assert.strictEqual(actual, expected)` everywhere, this provides
 * the handful of matchers the test suite actually uses, with the familiar
 * fluent shape. Tests run with `node --test`.
 */

import assert from 'node:assert/strict';

export interface Matchers<T> {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toHaveLength(n: number): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toContain(needle: unknown): void;
  toThrow(expected?: RegExp | (new (...args: never[]) => Error)): void;
  readonly not: Omit<Matchers<T>, 'not' | 'toThrow'>;
}

function build<T>(actual: T, negated: boolean): Matchers<T> {
  const ok = (condition: boolean, message: string): void => {
    assert.ok(negated ? !condition : condition, negated ? `NOT: ${message}` : message);
  };

  const matchers: Matchers<T> = {
    toBe(expected) {
      ok(Object.is(actual, expected), `expected ${fmt(actual)} to be ${fmt(expected)}`);
    },
    toEqual(expected) {
      if (negated) {
        assert.notDeepStrictEqual(actual, expected);
      } else {
        assert.deepStrictEqual(actual, expected);
      }
    },
    toBeNull() {
      ok(actual === null, `expected ${fmt(actual)} to be null`);
    },
    toBeUndefined() {
      ok(actual === undefined, `expected ${fmt(actual)} to be undefined`);
    },
    toBeDefined() {
      ok(actual !== undefined, `expected value to be defined`);
    },
    toBeTruthy() {
      ok(Boolean(actual), `expected ${fmt(actual)} to be truthy`);
    },
    toBeFalsy() {
      ok(!actual, `expected ${fmt(actual)} to be falsy`);
    },
    toHaveLength(n) {
      const len = (actual as { length?: number })?.length;
      ok(len === n, `expected length ${String(len)} to be ${n}`);
    },
    toBeCloseTo(expected, digits = 2) {
      const diff = Math.abs((actual as number) - expected);
      const tolerance = 10 ** -digits / 2;
      ok(diff < tolerance, `expected ${fmt(actual)} to be close to ${expected}`);
    },
    toBeGreaterThan(n) {
      ok((actual as number) > n, `expected ${fmt(actual)} > ${n}`);
    },
    toBeGreaterThanOrEqual(n) {
      ok((actual as number) >= n, `expected ${fmt(actual)} >= ${n}`);
    },
    toBeLessThan(n) {
      ok((actual as number) < n, `expected ${fmt(actual)} < ${n}`);
    },
    toBeLessThanOrEqual(n) {
      ok((actual as number) <= n, `expected ${fmt(actual)} <= ${n}`);
    },
    toContain(needle) {
      if (typeof actual === 'string') {
        ok(actual.includes(String(needle)), `expected ${fmt(actual)} to contain ${fmt(needle)}`);
        return;
      }
      const arr = actual as unknown as unknown[];
      ok(
        Array.isArray(arr) && arr.some((v) => deepEq(v, needle)),
        `expected collection to contain ${fmt(needle)}`,
      );
    },
    toThrow(expected) {
      assert.ok(typeof actual === 'function', 'toThrow requires a function');
      const fn = actual as unknown as () => unknown;
      if (expected === undefined) {
        assert.throws(fn);
      } else if (expected instanceof RegExp) {
        assert.throws(fn, expected);
      } else {
        assert.throws(fn, expected);
      }
    },
    get not() {
      return build(actual, !negated);
    },
  };
  return matchers;
}

function deepEq(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function fmt(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function expect<T>(actual: T): Matchers<T> {
  return build(actual, false);
}

/**
 * Minimal ambient declarations for the two Node built-ins the suite imports.
 *
 * The alternative is `@types/node`, which this project deliberately does not
 * take: package.json states there are no dependencies so the toolkit builds and
 * runs air-gapped, and the npm registry is in fact unreachable from the target
 * environment. `tsc` is an optional dev tool, but it should not be the thing
 * that forces a package install.
 *
 * Only what is actually used is declared. If a test reaches for more of the Node
 * API, widen this file rather than adding a dependency.
 */

declare module 'node:test' {
  type TestFn = () => void | Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  type ThrowsExpectation =
    | RegExp
    | (new (...args: never[]) => Error)
    | ((err: unknown) => boolean)
    | string;

  interface StrictAssert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    strictEqual(actual: unknown, expected: unknown, message?: string): void;
    notStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    fail(message?: string): never;
    throws(fn: () => unknown, expected?: ThrowsExpectation, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
  }
  const assert: StrictAssert;
  export default assert;
}

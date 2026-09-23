/**
 * Minimal ambient declarations for the Node built-ins the suite imports.
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
  interface TestOptions {
    readonly skip?: boolean | string;
  }
  export function describe(name: string, fn: () => void): void;
  export function describe(name: string, options: TestOptions, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export function it(name: string, options: TestOptions, fn: TestFn): void;
  export function before(fn: TestFn): void;
  export function after(fn: TestFn): void;
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

/* The manual-coverage test reads the shipped pages off disk, and the prebuilt
   test compares web/lib with the source; they are the only places in `src/`
   that touch the file system. */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}

declare module 'node:module' {
  export function stripTypeScriptTypes(code: string, options?: { mode?: 'strip' | 'transform'; sourceMap?: boolean }): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

/* The Orchestrator emulator (src/testing/vro-emulator.ts) runs package scripts
   in a VM context, makes its synchronous REST calls through curl, and starts a
   fake REST server in a child process; the package tests verify signatures
   and gunzip a SIGN header. */

declare module 'node:vm' {
  export function createContext(sandbox?: object): object;
  export function runInContext(code: string, context: object, options?: { filename?: string }): unknown;
  export class Script {
    constructor(code: string, options?: { filename?: string });
  }
}

declare module 'node:child_process' {
  export function execFileSync(file: string, args: readonly string[], options: { input?: string; encoding: 'utf8'; maxBuffer?: number; stdio?: readonly string[]; env?: Readonly<Record<string, string>>; cwd?: string }): string;
  interface Readable {
    on(event: 'data', listener: (chunk: { toString(): string }) => void): void;
  }
  export interface ChildProcess {
    readonly stdout: Readable;
    readonly stderr: Readable;
    kill(): boolean;
    on(event: 'exit', listener: (code: number | null) => void): void;
  }
  export function spawn(command: string, args: readonly string[], options?: { stdio?: readonly string[] }): ChildProcess;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:fs' {
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function chmodSync(path: string, mode: number): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module 'node:crypto' {
  export class X509Certificate {
    constructor(der: Uint8Array);
    readonly publicKey: object;
    readonly subject: string;
  }
  interface Verify {
    update(data: Uint8Array): Verify;
    verify(key: object, signature: Uint8Array): boolean;
  }
  export function createVerify(algorithm: string): Verify;
}

declare module 'node:zlib' {
  export function gunzipSync(data: Uint8Array): Uint8Array;
}

/**
 * A fake REST server in a child process, for the Orchestrator emulator's tests.
 *
 * It has to be another process: the emulator's HTTP calls are synchronous (as
 * Orchestrator's are), so a server on the test's own event loop would never
 * answer them. The server script is written to a temporary folder and run with
 * node; it logs every request to a file the test reads back.
 *
 * A route answers when its method and path (a regular expression over the
 * path and query) match, and its host too when it has one. `responses` answers
 * in turn and then repeats its last; otherwise `status` (default 200) and
 * `body` (JSON unless it is a string). Anything unmatched is a 404.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeRoute {
  readonly method?: string;
  /** Regular expression over path + query, e.g. "^/api/session$". */
  readonly path: string;
  /** Regular expression over the Host header (host:port). */
  readonly host?: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly responses?: readonly { readonly status?: number; readonly body?: unknown }[];
}

export interface FakeRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly status: number;
}

export interface FakeServer {
  readonly port: number;
  /** Every request so far, in order. */
  requests(): FakeRequest[];
  stop(): void;
}

const SERVER = String.raw`
import { createServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';
const [routesFile, logFile] = process.argv.slice(2);
const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
const used = routes.map(() => 0);
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const host = req.headers.host || '';
    const i = routes.findIndex((r) => (!r.method || r.method === req.method) && new RegExp(r.path).test(req.url) && (!r.host || new RegExp(r.host).test(host)));
    let status = 404, out = { error: 'no route for ' + req.method + ' ' + req.url };
    if (i >= 0) {
      const r = routes[i];
      const answer = r.responses ? r.responses[Math.min(used[i], r.responses.length - 1)] : r;
      used[i]++;
      status = answer.status || 200;
      out = answer.body === undefined ? '' : answer.body;
    }
    appendFileSync(logFile, JSON.stringify({ method: req.method, host, path: req.url, headers: req.headers, body, status }) + '\n');
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof out === 'string' ? out : JSON.stringify(out));
  });
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`;

export async function startFakeServer(routes: readonly FakeRoute[]): Promise<FakeServer> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-'));
  writeFileSync(join(dir, 'server.mjs'), SERVER);
  writeFileSync(join(dir, 'routes.json'), JSON.stringify(routes));
  writeFileSync(join(dir, 'log.jsonl'), '');
  const child = spawn('node', [join(dir, 'server.mjs'), join(dir, 'routes.json'), join(dir, 'log.jsonl')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    let seen = '';
    child.stdout.on('data', (chunk) => {
      seen += chunk.toString();
      const m = /PORT (\d+)/.exec(seen);
      if (m) resolve(Number(m[1]));
    });
    child.stderr.on('data', (chunk) => reject(new Error(chunk.toString())));
    child.on('exit', (code) => reject(new Error(`fake server exited (${code})`)));
  });
  return {
    port,
    requests: () =>
      readFileSync(join(dir, 'log.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeRequest),
    stop: () => {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

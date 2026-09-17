#!/usr/bin/env node
/**
 * Static file server for local development — zero dependencies.
 *
 * ES modules cannot be loaded over file:// in most browsers (module scripts are
 * subject to CORS, and file:// origins are opaque), so opening web/index.html
 * directly will not work during development. This serves web/ over HTTP.
 *
 * For distribution the same files work from any static host, or from a zip
 * extracted behind an internal web server.
 *
 * Usage:  node tools/serve.mjs [--port 8080] [--host 127.0.0.1]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
};

function parseArgs(argv) {
  const args = { port: 8080, host: '127.0.0.1', tries: 12 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
    else if (argv[i] === '--host' && argv[i + 1]) args.host = String(argv[++i]);
    else if (argv[i] === '--tries' && argv[i + 1]) args.tries = Number(argv[++i]);
  }
  return args;
}

const { port, host, tries } = parseArgs(process.argv.slice(2));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve inside web/ and refuse anything that escapes it.
    const candidate = resolve(join(WEB, normalize(pathname)));
    if (!candidate.startsWith(WEB)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    let filePath = candidate;
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Not found: ${pathname}`);
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      // Development server: never cache, so a rebuild is picked up on reload.
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Server error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

/**
 * Bind to the first port that will accept us.
 *
 * On Windows, Hyper-V, WSL and Docker reserve blocks of TCP ports, and binding
 * inside a reserved block fails with EACCES even though nothing is listening
 * and the user is an administrator. Port 8080 frequently falls inside one of
 * those blocks. Rather than crashing on an unhandled 'error' event, walk
 * forward until a port works and report which one was used.
 *
 * To see the reserved ranges on Windows:
 *   netsh interface ipv4 show excludedportrange protocol=tcp
 */
function listenWithFallback(startPort, attemptsRemaining) {
  const attempt = (candidate, remaining) => {
    // Both handlers must be torn down between attempts. `listen(port, cb)`
    // registers cb as a one-shot 'listening' listener, and a failed attempt
    // leaves it attached — so without this the next successful bind fires every
    // stale callback and reports ports that never opened.
    const cleanup = () => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };

    const onListening = () => {
      cleanup();
      console.log(`ArchToolKit serving web/ at http://${host}:${candidate}/`);
      if (candidate !== startPort) {
        console.log(`(Requested port ${startPort} was unavailable.)`);
      }
      console.log('Press Ctrl-C to stop.');
    };

    const onError = (err) => {
      const recoverable = err.code === 'EACCES' || err.code === 'EADDRINUSE';
      if (!recoverable || remaining <= 0) {
        cleanup();
        console.error(`\nCould not start the server on ${host}:${candidate} — ${err.code}.`);
        if (err.code === 'EACCES') {
          console.error(
            'Permission denied binding that port. On Windows the usual causes are:\n' +
              '  - an OS-reserved port range:\n' +
              '      netsh interface ipv4 show excludedportrange protocol=tcp\n' +
              '  - a URL ACL reserved by another account:\n' +
              '      netsh http show urlacl\n' +
              '  - endpoint security intercepting listening sockets\n' +
              'Or just pick another port:  node tools/serve.mjs --port 3000',
          );
        }
        process.exitCode = 1;
        return;
      }

      // EACCES on Windows has several causes and they are not distinguishable
      // from here: an OS-reserved port range, a netsh http URL ACL held by
      // another account, or endpoint security intercepting listening sockets.
      // Report what happened rather than guessing which.
      const reason = err.code === 'EACCES' ? 'not permitted (EACCES)' : 'already in use';
      console.log(`  Port ${candidate} is ${reason}, trying ${candidate + 1}…`);
      cleanup();
      attempt(candidate + 1, remaining - 1);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(candidate, host);
  };

  attempt(startPort, attemptsRemaining);
}

listenWithFallback(port, tries);

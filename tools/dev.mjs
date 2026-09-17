#!/usr/bin/env node
/**
 * Development entry point: build, watch and serve in one process.
 *
 * Usage:  node tools/dev.mjs [--port 8080]
 */

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));

function run(script, args) {
  const child = spawn(process.execPath, [join(TOOLS, script), ...args], {
    stdio: 'inherit',
    // The type stripper is still flagged experimental; its warning is noise here.
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) process.exitCode = code;
  });
  return child;
}

const passthrough = process.argv.slice(2);

const builder = run('build.mjs', ['--watch']);
const server = run('serve.mjs', passthrough);

const shutdown = () => {
  builder.kill();
  server.kill();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

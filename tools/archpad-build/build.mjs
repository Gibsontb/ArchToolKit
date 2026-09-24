// Bundles CodeMirror 6 for ArchPad into one offline ES module:
//   src/vendor/archpad-editor.js  (copied to web/lib/vendor by the normal build)
// Run once after `npm install` in this folder, or to upgrade CodeMirror:
//   node tools/archpad-build/build.mjs
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, 'entry.js')],
  outfile: join(here, '..', '..', 'src', 'vendor', 'archpad-editor.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: ['es2022'],
  legalComments: 'eof',
  banner: { js: '// CodeMirror 6 (MIT, Marijn Haverbeke and contributors) bundled for ArchPad. Do not edit: rebuild with tools/archpad-build/build.mjs.' },
});
console.log('Bundled CodeMirror into src/vendor/archpad-editor.js');

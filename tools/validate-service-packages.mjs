/** Validate exported service ZIPs without planning or applying cloud resources.
 * node tools/validate-service-packages.mjs --terraform /path/to/terraform package.zip ...
 * Scratch modules and a JSON report stay in .work/tmp. Provider downloads are cached.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openZip } from '../src/core/zip.ts';
import { WORK_CACHE, WORK_TMP } from './work.mjs';
import { terraformEnv } from './terraform-init.mjs';

const args = process.argv.slice(2);
let terraform = 'terraform';
let keepData = false;
const packages = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--terraform') {
    if (!args[index + 1]) throw new Error('--terraform requires an executable path');
    terraform = resolve(args[++index]);
  } else if (args[index] === '--keep-data') keepData = true;
  else packages.push(resolve(args[index]));
}
if (!packages.length) throw new Error('Supply one or more exported service ZIP paths.');
const work = mkdtempSync(join(WORK_TMP, 'service-package-validation-'));
// Terraform's plugin cache is not safe for concurrent init processes. Keep this
// tool's cache separate from update.bat and serialize validation runs using it.
const cache = join(WORK_CACHE, 'service-provider-cache');
mkdirSync(cache, { recursive: true });
const lock = join(cache, 'validation.lock');
let announced = false;
for (;;) {
  try {
    const handle = openSync(lock, 'wx');
    writeFileSync(handle, String(process.pid));
    closeSync(handle);
    break;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = Number(readFileSync(lock, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); }
      catch (error) { if (error.code === 'ESRCH') { unlinkSync(lock); continue; } }
    }
    if (!announced) { console.log('Waiting for the preceding service validation run to release its provider cache.'); announced = true; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
process.on('exit', () => { try { if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock); } catch {} });
// Windows copies cached provider executables instead of linking them. Share one
// data directory within this sequential run rather than copying a provider per ZIP.
const env = terraformEnv({ TF_PLUGIN_CACHE_DIR: cache, TF_DATA_DIR: join(work, 'terraform-data') });
const results = [];
for (const [index, archive] of packages.entries()) {
  const directory = join(work, String(index + 1));
  mkdirSync(directory);
  try {
    const zip = openZip(new Uint8Array(readFileSync(archive)));
    const manifest = JSON.parse(await zip.text('service-deployment.json'));
    if (manifest.kind !== 'archtoolkit.service-deployment' || manifest.engine !== 'terraform') throw new Error('Expected an exported Terraform service deployment.');
    for (const name of zip.names) {
      if (name.includes('\\') || name.includes(':') || isAbsolute(name) || name.split('/').some(part => part === '..')) throw new Error('Unsafe archive path.');
      const destination = resolve(directory, name);
      const within = relative(directory, destination);
      if (!within || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error('Archive entry escapes the module.');
      // Include text assets referenced by file()/templatefile(), without executing
      // them. Never load archived providers, Terraform data or CLI configuration.
      if (name.split('/').some(part => part === '.terraform' || part === '.git')) continue;
      if (!/\.(?:tf|tf\.json|py|json|sql|ya?ml|tftpl|tpl)$/.test(name)) continue;
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, await zip.text(name));
    }
    if (!zip.names.some(name => /^[^/]+\.tf(?:\.json)?$/.test(name))) throw new Error('No root Terraform configuration.');
    console.log('Validating ' + manifest.resource + ' from ' + archive);
    const run = command => spawnSync(terraform, ['-chdir=' + directory, ...command], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
    const init = run(['init', '-backend=false', '-input=false', '-no-color']);
    if (init.error || init.status !== 0) throw new Error(init.error?.message ?? init.stderr + init.stdout);
    const validation = run(['validate', '-json']);
    if (validation.error) throw validation.error;
    const report = JSON.parse(validation.stdout);
    results.push({ archive, resource: manifest.resource, valid: report.valid === true, diagnostics: report.diagnostics });
    console.log(report.valid ? '  Valid' : '  Invalid — see report');
  } catch (error) {
    results.push({ archive, valid: false, error: String(error) });
    console.log('  Failed — ' + String(error));
  }
  writeFileSync(join(work, 'report.json'), JSON.stringify(results, null, 2));
}
console.log('Validation report ' + join(work, 'report.json'));
if (!keepData) {
  try {
    const root = realpathSync(work), data = realpathSync(env.TF_DATA_DIR);
    if (data !== resolve(root, 'terraform-data') || !data.startsWith(root + sep)) throw new Error('Unsafe scratch-data cleanup target');
    rmSync(data, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
  } catch (error) { if (error.code !== 'ENOENT') console.warn('Scratch provider data was retained: ' + String(error)); }
}
if (results.some(result => !result.valid)) process.exitCode = 1;

#!/usr/bin/env node
/**
 * Drive the built pages in a real browser.
 *
 * The unit suite proves the domain logic; it cannot prove that a page mounts.
 * Two defects got through a green suite and a clean typecheck and were only
 * found here: a redraw triggered by the blur of clicking a button destroyed the
 * button mid-click, and a `let` declared after the code that reached it left the
 * spec builder dead on arrival whenever a handoff was present. Neither is
 * visible without a browser.
 *
 * Playwright is not a dependency of this project and cannot be, since the
 * toolkit has to build and run air-gapped. When it is absent this exits 0 and
 * says so: a check you cannot run is not a failure.
 *
 * Usage:  node tools/browser-check.mjs [--port 8140]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 8140;
const BASE = `http://127.0.0.1:${PORT}`;

let chromium;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  try {
    chromium = createRequire(`${process.env.HOME}/`)('playwright').chromium;
  } catch {
    console.log('Playwright is not installed, so the browser checks were skipped.');
    console.log('  npm install --no-save playwright && npx playwright install chromium');
    process.exit(0);
  }
}

const server = spawn(
  process.execPath,
  [join(TOOLS, 'serve.mjs'), '--port', String(PORT), '--tries', '0'],
  { stdio: 'ignore', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
);
const stop = () => server.kill();
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

await new Promise((r) => setTimeout(r, 1500));

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();

/** The synthetic RVTools workbook, written by the chain block and reused after it. */
let fixture;

// --- every page mounts without a console error ----------------------------
for (const [name, path] of [
  ['index', '/'],
  ['inventory', '/app/inventory.html'],
  ['sizing', '/app/vcf-sizing.html'],
  ['spec', '/app/vcf-spec.html'],
  ['terraform', '/app/terraform.html'],
  ['ansible', '/app/ansible.html'],
  ['multicloud', '/app/multicloud.html'],
  ['migration', '/app/migration.html'],
  ['portfolio', '/app/migration-portfolio.html'],
]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  const text = (await page.locator('body').innerText()).length;
  check(`${name} mounts`, errors.length === 0 && text > 200, errors[0] ?? `${text} chars`);
  await ctx.close();
}

// --- editing a field must not break the buttons ---------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/vcf-sizing.html`, { waitUntil: 'networkidle' });
  const hosts = page.locator('.field', { hasText: 'Hosts in mgmt cluster' }).locator('input').first();
  await hosts.fill('7');
  await hosts.dispatchEvent('change');
  await page.waitForTimeout(400);
  await page.locator('button', { hasText: 'Continue in the spec' }).click();
  await page.waitForTimeout(1500);
  check('a button still works after editing a field', page.url().endsWith('/vcf-spec.html'));

  const banner = await page.locator('text=Prefilled from your sizing').count();
  check('the spec builder receives the handoff', banner === 1);
  const carried = await page
    .locator('.field', { hasText: 'Host count' })
    .locator('input')
    .first()
    .inputValue();
  check('the host count carries across', carried === '7', `got ${carried}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  check(
    'reloading does not re-apply a spent handoff',
    (await page.locator('text=Prefilled from your sizing').count()) === 0,
  );
  await ctx.close();
}

// --- the whole chain, from an RVTools workbook to a document --------------
{
  // A synthetic RVTools workbook (src/testing/estate-fixture.ts): two vCenters,
  // a four-host vSAN management cluster, and clusters that share a name. It
  // goes in as the .xlsx RVTools writes, and has to come out the far end as a
  // spec with the management cluster's own hosts, DNS and networks in it.
  const { estateWorkbook } = await import('../src/testing/estate-fixture.ts');
  fixture = join(mkdtempSync(join(tmpdir(), 'atk-')), 'estate.xlsx');
  writeFileSync(fixture, await estateWorkbook());

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/inventory.html`, { waitUntil: 'networkidle' });
  await page.locator('.estate-bar input[type=file]').setInputFiles(fixture);
  await page.waitForFunction(() => /As a VCF fleet/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => undefined);
  const inventoryText = await page.locator('body').innerText();

  check('the workbook imports as it is', /Estate:\s*estate\.xlsx/.test(inventoryText));
  check('the estate becomes a VCF fleet plan', /As a VCF fleet/.test(inventoryText));
  check('every VM is checked for a move', /Moving the VMs/.test(inventoryText) && /Physical-mode raw device mapping/.test(inventoryText));
  check('both vCenters are listed', /vc01\.example\.com/.test(inventoryText) && /vc02\.example\.com/.test(inventoryText));

  await page.locator('a', { hasText: 'Open in sizing' }).click();
  await page.waitForFunction(() => /VCF fleet from the estate/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => undefined);
  const sizingText = await page.locator('body').innerText();
  check('sizing reads the estate without being handed it', /VCF fleet from the estate/.test(sizingText));
  check('sizing lays out a workload domain per vCenter', /wld-vc01/.test(sizingText) && /wld-vc02/.test(sizingText));
  const mgmtHosts = await page.locator('.field', { hasText: 'Hosts in mgmt cluster' }).locator('input').first().inputValue();
  check('the management cluster is converged with its own hosts', mgmtHosts === '4', `got ${mgmtHosts}`);
  const ram = await page.locator('.field', { hasText: 'RAM (GiB)' }).locator('input').first().inputValue();
  check('its hosts set the per-host profile', ram === '1024', `got ${ram}`);

  // Starting on new hosts instead rewrites the form.
  const mgmt = page.getByLabel('Management domain', { exact: true });
  await mgmt.selectOption('new');
  await page.waitForTimeout(500);
  const path = await page.locator('.field', { hasText: 'Deployment path' }).locator('select').inputValue();
  check('choosing new hosts makes it a greenfield management domain', path === 'greenfield', `got ${path}`);
  await mgmt.selectOption({ index: 1 });
  await page.waitForTimeout(500);

  // No Continue: opening the spec builder is enough once sizing has an estate.
  await page.goto(`${BASE}/app/vcf-spec.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const specText = await page.locator('body').innerText();
  check('the spec builder follows sizing without Continue', /Prefilled from your sizing/.test(specText));
  check('a document comes out the far end', /"sddcId"/.test(specText));
  check('with the converged hosts in it', /"esx01/.test(specText) && /"esx04/.test(specText));
  check('and the estate’s DNS and management network', /10\.0\.0\.2/.test(specText) && /10\.0\.0\.0\/24/.test(specText));

  // A fresh tab has no sizing, only the stored estate: the spec builder sizes
  // it on the defaults and fills itself in anyway.
  const fresh = await ctx.newPage();
  await fresh.goto(`${BASE}/app/vcf-spec.html`, { waitUntil: 'networkidle' });
  await fresh.waitForFunction(() => /Prefilled from your estate/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => undefined);
  const freshText = await fresh.locator('body').innerText();
  check('a new tab’s spec builder fills itself from the estate', /Prefilled from your estate/.test(freshText) && /"esx01/.test(freshText));
  await fresh.close();

  // The generators build from the same estate.
  await page.goto(`${BASE}/app/terraform.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.locator('select:not([data-control])').first().selectOption('vsphere');
  await page.waitForTimeout(300);
  const tfList = page.locator('select:not([data-control])').nth(1);
  const tfLabels = await tfList.locator('option').allInnerTexts();
  await tfList.selectOption({ index: tfLabels.findIndex((t) => /landing zone/i.test(t)) });
  await page.waitForTimeout(300);
  const cluster = page.locator('.field', { hasText: 'Source cluster' }).locator('select');
  const clusterOptions = await cluster.locator('option').allInnerTexts();
  check('the estate’s clusters are offered', clusterOptions.includes('Cluster01'), clusterOptions.join(', '));
  await cluster.selectOption('Cluster01');
  await page.locator('button', { hasText: 'Generate Terraform' }).click();
  await page.waitForTimeout(800);
  const tf = (await page.locator('pre.code-block').allInnerTexts()).join('\n');
  check('Terraform builds the landing zone from the estate', /vsphere_distributed_port_group/.test(tf) && /vlan_id\s+= 110/.test(tf), tf.slice(0, 120));

  await page.goto(`${BASE}/app/multicloud.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.locator('button', { hasText: 'Answer from the estate' }).click();
  await page.waitForTimeout(300);
  check(
    'the decision wizard answers from the estate',
    (await page.locator('#sourceEnv').inputValue()) === 'onprem-vmware' &&
      (await page.locator('#initiativeType').inputValue()) === 'migration',
  );

  await page.goto(`${BASE}/app/inventory.html`, { waitUntil: 'networkidle' });
  await page.locator('.estate-bar button', { hasText: 'Forget' }).click();
  await page.waitForTimeout(500);
  check('forgetting the estate clears it', /No estate loaded/.test(await page.locator('body').innerText()));
  await ctx.close();
}

// --- the data editor: a VCF export, then the other kinds of file -----------
{
  const { LAB_911_THREE_HOST_FC } = await import('../src/vcf/__fixtures__/real-specs.ts');
  const dir = mkdtempSync(join(tmpdir(), 'atk-'));
  const labFile = join(dir, 'VCF-deployment-spec-9.1.1.0.json');
  writeFileSync(labFile, JSON.stringify(LAB_911_THREE_HOST_FC));

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // The old address still works.
  await page.goto(`${BASE}/app/vcf-spec-editor.html`, { waitUntil: 'networkidle' });
  check('Editor: the old spec editor address lands on the data editor', /\/data-editor\.html\?profile=vcf-spec$/.test(page.url()), page.url());
  check('No page carries the old 1-2-3 step strip', (await page.locator('.flow-steps').count()) === 0 && /Open a file/i.test(await page.locator('body').innerText()));
  await page.locator('input[type=file]').first().setInputFiles(labFile);
  await page.waitForTimeout(600);
  const opened = await page.locator('body').innerText();
  check('Editor: an installer export opens field by field', /Distributed switches/.test(opened) && (await page.locator('[data-path="hostSpecs[0].hostname"]').count()) === 1);
  check('Editor: it is recognised as a VCF spec', (await page.locator('[data-control="profile"]').inputValue()) === 'vcf-spec');
  check('Editor: the export checks clean against 9.1', /\bValid\b/.test(opened));
  check('Editor: sizes are dropdowns', (await page.locator('select[data-path="vcenterSpec.storageSize"]').count()) === 1);
  check('Editor: it says it is holding passwords', /Secrets held\s+3/i.test(opened));

  await page.locator('[data-path="hostSpecs[2].hostname"]').fill('esx05.example.com');
  await page.waitForTimeout(200);
  check('Editor: a change is listed', /hostSpecs\[2\]\.hostname/.test(await page.locator('.je-changes').innerText()));

  await page.getByPlaceholder('Find, e.g.').fill('10.20.1.');
  await page.getByPlaceholder('Replace with').fill('10.30.7.');
  await page.locator('button', { hasText: 'Replace all' }).click();
  await page.waitForTimeout(300);
  const gw = await page.locator('[data-path="networkSpecs[0].gateway"]').inputValue();
  check('Editor: find and replace re-addresses every field', gw === '10.30.7.1', gw);

  await page.locator('[data-path="networkSpecs[3].subnet"]').fill('10.30.7.0/26');
  await page.waitForTimeout(300);
  check('Editor: a bad edit is caught', /\bErrors\b/.test(await page.locator('body').innerText()));
  await page.locator('[data-control="undo"]').click();
  await page.waitForTimeout(300);
  check('Editor: undo puts it back', !/\bErrors\b/.test(await page.locator('body').innerText()));

  // The text view shows the same document, with its line numbers.
  await page.locator('[data-view="text"]').click();
  await page.waitForTimeout(200);
  const text = await page.locator('.de-textarea').inputValue();
  check('Editor: the text view holds the edited JSON', text.includes('esx05.example.com') && (await page.locator('.de-gutter span').count()) > 50);

  // And the builder hands its own spec over.
  await page.goto(`${BASE}/app/vcf-spec.html`, { waitUntil: 'networkidle' });
  await page.locator('button', { hasText: 'Edit as JSON' }).click();
  await page.waitForTimeout(800);
  check('Editor: the builder opens its spec in the editor', /data-editor\.html/.test(page.url()) && (await page.locator('[data-path="sddcId"]').count()) === 1);
  await ctx.close();
}

{
  const dir = mkdtempSync(join(tmpdir(), 'atk-'));
  const playbook = join(dir, 'site.yml');
  writeFileSync(
    playbook,
    `---\n# Web tier\n- name: Web\n  hosts: web\n  tasks:\n  - name: Install\n    ansible.builtin.package:\n      name: nginx\n      state: present\n  - name: Typo\n    community.vmware.vmware_gest:\n      name: web01\n`,
  );
  const cfn = join(dir, 'stack.yaml');
  writeFileSync(cfn, `Resources:\n  Logs:\n    Type: AWS::S3::Bucket\nOutputs:\n  Arn:\n    Value: !GetAtt Log.Arn\n`);
  const k8s = join(dir, 'app.yaml');
  writeFileSync(k8s, `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\nspec:\n  template:\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.27\n          imagePullPolicy: Always\n`);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/data-editor.html`, { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').first().setInputFiles(playbook);
  await page.waitForTimeout(500);
  check('Editor: a playbook is recognised', (await page.locator('[data-control="profile"]').inputValue()) === 'ansible-playbook');
  check('Editor: a misspelt module is found', (await page.locator('[data-finding="ansible.module.unknown"]').count()) === 1);
  check('Editor: module state is a dropdown', (await page.locator('select[data-path="[0].tasks[0][\\"ansible.builtin.package\\"].state"]').count()) === 1);
  check('Editor: it warns that a form edit drops comments', (await page.locator('[data-note="comments"]').count()) === 1);
  await page.locator('[data-view="text"]').click();
  await page.locator('[data-finding="ansible.module.unknown"]').click();
  const sel = await page.locator('.de-textarea').evaluate((t) => t.value.slice(t.selectionStart, t.selectionEnd));
  check('Editor: a finding goes to its line in the text', /vmware_gest/.test(sel), sel);
  await page.locator('.de-textarea').fill((await page.locator('.de-textarea').inputValue()).replace('vmware_gest', 'vmware_guest'));
  await page.waitForTimeout(600);
  check('Editor: fixing the text clears the finding and keeps the comment', (await page.locator('[data-finding="ansible.module.unknown"]').count()) === 0 && (await page.locator('.de-textarea').inputValue()).includes('# Web tier'));

  await page.locator('input[type=file]').first().setInputFiles(cfn);
  await page.waitForTimeout(500);
  check('Editor: CloudFormation is recognised, with the bad GetAtt found', (await page.locator('[data-control="profile"]').inputValue()) === 'aws-cloudformation' && (await page.locator('[data-finding="cfn.getatt"]').count()) === 1);

  await page.locator('input[type=file]').first().setInputFiles(k8s);
  await page.waitForTimeout(500);
  check('Editor: a two-document manifest opens as two documents', (await page.locator('[data-control="profile"]').inputValue()) === 'kubernetes' && /Document 2/.test(await page.locator('.je-tree').innerText()));
  await page.locator('select[data-path="[1].spec.template.spec.containers[0].imagePullPolicy"]').selectOption('IfNotPresent');
  await page.waitForTimeout(200);
  await page.locator('[data-view="text"]').click();
  const k8sText = await page.locator('.de-textarea').inputValue();
  check('Editor: a form edit writes both documents back', (k8sText.match(/^---$/gm) ?? []).length === 2 && k8sText.includes('IfNotPresent'));
  await ctx.close();
}

// --- Load, Save and Clear on the builder and both generators ---------------
{
  const { LAB_911_THREE_HOST_FC } = await import('../src/vcf/__fixtures__/real-specs.ts');
  const { readFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'atk-'));
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const save = async (format) => {
    await page.locator('[data-control="settings-format"]').selectOption(format);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-control="settings-save"]').click()]);
    const path = join(dir, download.suggestedFilename());
    await download.saveAs(path);
    return { path, text: readFileSync(path, 'utf8'), name: download.suggestedFilename() };
  };
  const clearForm = async () => {
    await page.locator('[data-control="settings-clear"]').click();
    await page.locator('[data-control="settings-clear"]').click();
    await page.waitForTimeout(300);
  };
  const load = async (path) => {
    await page.locator('[data-control="settings-file"]').setInputFiles(path);
    await page.waitForTimeout(500);
    return page.locator('[data-control="settings-status"]').innerText();
  };

  // The spec builder.
  await page.goto(`${BASE}/app/vcf-spec.html`, { waitUntil: 'networkidle' });
  const sddc = page.getByLabel('SDDC ID', { exact: true });
  await sddc.fill('lab-m42');
  await page.waitForTimeout(300);
  const yaml = await save('yaml');
  check('Builder: Save writes YAML settings', yaml.name === 'lab-m42-builder-settings.yaml' && /sddcId: lab-m42/.test(yaml.text), yaml.name);
  check('Builder: and no passwords', !/password/i.test(yaml.text.replace(/Passwords are not saved/, '')));
  const txt = await save('txt');
  check('Builder: TXT is one field per line', /^fields\.sddcId = lab-m42$/m.test(txt.text));
  await clearForm();
  check('Builder: Clear puts the form back', (await sddc.inputValue()) === 'vcf-m01', await sddc.inputValue());
  const status = await load(txt.path);
  check('Builder: Load brings it back from TXT', (await sddc.inputValue()) === 'lab-m42' && /Loaded/.test(status), status);
  check('Builder: and the document follows', /"sddcId": "lab-m42"/.test(await page.locator('body').innerText()));
  const labFile = join(dir, 'lab.json');
  writeFileSync(labFile, JSON.stringify(LAB_911_THREE_HOST_FC));
  check('Builder: a deployment spec is sent to the Data editor', /Data editor/.test(await load(labFile)));

  // Terraform, then the same file offered to Ansible.
  await page.goto(`${BASE}/app/terraform.html`, { waitUntil: 'networkidle' });
  const label = page.getByPlaceholder('Used in comments, tags and the filename');
  await label.fill('prod-landing');
  const tf = await save('json');
  const tfJson = JSON.parse(tf.text);
  check('Terraform: Save writes the platform, blueprint and values', tfJson.kind === 'archtoolkit.terraform-generator' && tfJson.values.__name === 'prod-landing' && typeof tfJson.blueprint === 'string');
  await clearForm();
  check('Terraform: Clear empties the parameters', (await label.inputValue()) === '');
  const tfStatus = await load(tf.path);
  check('Terraform: Load restores them', (await label.inputValue()) === 'prod-landing', tfStatus);
  const tfYaml = await save('yaml');
  await clearForm();
  await load(tfYaml.path);
  check('Terraform: and from YAML', (await page.getByPlaceholder('Used in comments, tags and the filename').inputValue()) === 'prod-landing');

  await page.goto(`${BASE}/app/ansible.html`, { waitUntil: 'networkidle' });
  check('Ansible: has Load, Save and Clear', (await page.locator('[data-control="settings-load"]').count()) === 1 && (await page.locator('[data-control="settings-clear"]').count()) === 1);
  check('Ansible: a Terraform file is refused, and says why', /Terraform page/.test(await load(tf.path)));
  await page.getByPlaceholder('Used in comments, tags and the filename').fill('patching');
  const an = await save('txt');
  await clearForm();
  await load(an.path);
  check('Ansible: Load restores its own TXT', (await page.getByPlaceholder('Used in comments, tags and the filename').inputValue()) === 'patching');
  await ctx.close();
}

// --- the Terraform build list: several blueprints into one stack -----------
{
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/app/terraform.html`, { waitUntil: 'networkidle' });
  const pick = (n) => page.locator('select:not([data-control])').nth(n);
  const label = () => page.getByPlaceholder('Used in comments, tags and the filename');

  await pick(1).selectOption({ label: 'VPC baseline (2 subnets + IGW)' });
  await label().fill('network');
  await page.locator('[data-control="add-to-build"]').click();
  await page.waitForTimeout(300);
  check('Stack: an item goes into the build list', (await page.locator('.build-item').count()) === 1);

  await pick(1).selectOption({ label: 'EC2 instance + security group' });
  await label().fill('web');
  await page.waitForTimeout(200);
  const subnet = page.locator('.field', { hasText: 'Subnet ID' });
  const offered = await subnet.locator('.ref-picker option').allInnerTexts();
  check('Stack: a field offers what the first item creates', offered.includes('aws_subnet.public_a.id'), offered.slice(0, 4).join(', '));
  await subnet.locator('.ref-picker').selectOption('aws_subnet.public_a.id');
  await page.waitForTimeout(200);
  check('Stack: picking one fills the field in', (await subnet.locator('input').inputValue()).includes('${aws_subnet.public_a.id}'));
  await page.locator('[data-control="add-to-build"]').click();
  await page.waitForTimeout(300);

  await page.locator('[data-control="stack-name"]').fill('prod-landing-zone');
  await page.locator('[data-control="generate-stack"]').click();
  await page.waitForTimeout(600);
  const files = await page.locator('.file-head strong').allInnerTexts();
  check('Stack: one file per item, plus the shared files', ['01-network.tf', '02-web.tf', 'versions.tf', 'providers.tf', 'variables.tf', 'README.md'].every((f) => files.includes(f)), files.join(', '));
  const code = (await page.locator('pre.code-block').allInnerTexts()).join('\n');
  check('Stack: the reference survives into the configuration', code.includes('aws_subnet.public_a.id'));
  check('Stack: one terraform block for the whole stack', (code.match(/required_providers/g) ?? []).length === 1);
  check('Stack: it generated without errors', /Generated\. No errors\./.test(await page.locator('body').innerText()));

  // The list saves and loads with the rest of the form.
  const dir = mkdtempSync(join(tmpdir(), 'atk-'));
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-control="settings-save"]').click()]);
  const path = join(dir, download.suggestedFilename());
  await download.saveAs(path);
  await page.locator('[data-control="settings-clear"]').click();
  await page.locator('[data-control="settings-clear"]').click();
  await page.waitForTimeout(300);
  check('Stack: Clear empties the build list', (await page.locator('.build-item').count()) === 0);
  await page.locator('[data-control="settings-file"]').setInputFiles(path);
  await page.waitForTimeout(500);
  check('Stack: Load brings the whole list back', (await page.locator('.build-item').count()) === 2, await page.locator('[data-control="settings-status"]').innerText());
  check('Stack: no script errors', errors.length === 0, errors[0] ?? '');
  await ctx.close();
}

// --- clear all: every page has it, and it empties the toolkit ---------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pages = ['index.html', 'app/inventory.html', 'app/vcf-sizing.html', 'app/vcf-spec.html', 'app/data-editor.html', 'app/multicloud.html', 'app/migration.html', 'app/migration-portfolio.html', 'app/terraform-map.html', 'app/terraform.html', 'app/ansible.html', 'app/manual.html'];
  const missing = [];
  for (const p of pages) {
    await page.goto(`${BASE}/${p}`, { waitUntil: 'networkidle' });
    if ((await page.locator('[data-control="clear-all"]').count()) !== 1) missing.push(p);
  }
  check('Clear all: every page has the button', missing.length === 0, missing.join(', '));

  await page.goto(`${BASE}/app/data-editor.html`, { waitUntil: 'networkidle' });
  await page.locator('[data-control="paste"]').fill('{"a": 1}');
  await page.locator('button', { hasText: 'Open pasted text' }).click();
  await page.waitForTimeout(300);
  await page.evaluate(() => sessionStorage.setItem('archtoolkit.test', 'x'));
  await page.locator('[data-control="clear-all"]').click();
  check('Clear all: the first press only arms it', /Click again/.test(await page.locator('[data-control="clear-all"]').innerText()));
  await page.locator('[data-control="clear-all"]').click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  const left = await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('archtoolkit.')).length);
  check('Clear all: the second press empties the page and the saved work', left === 0 && (await page.locator('[data-path="a"]').count()) === 0, `left ${left}`);
  await ctx.close();
}

// --- the pickers actually change the document -----------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/vcf-spec.html`, { waitUntil: 'networkidle' });

  const scenario = page.locator('select').filter({ hasText: 'Deploy a new VCF fleet' }).first();
  await scenario.selectOption('new-vvf');
  await page.waitForTimeout(400);
  check(
    'vSphere Foundation drops NSX from the document',
    !/"nsxtSpec"/.test(await page.locator('body').innerText()),
  );
  await scenario.selectOption('new-vcf-fleet');
  await page.waitForTimeout(400);
  check(
    'a VCF scenario restores NSX',
    /"nsxtSpec"/.test(await page.locator('body').innerText()),
  );

  const storage = page.locator('select').filter({ hasText: 'vSAN ESA' }).first();
  await storage.selectOption('nfs');
  await page.waitForTimeout(400);
  check(
    'choosing NFS reveals the fields it needs',
    (await page.getByText('NFS servers', { exact: false }).count()) > 0,
  );
  await ctx.close();
}

// --- module blueprints: what most Terraform actually looks like ----------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/terraform.html`, { waitUntil: 'networkidle' });
  await page.locator('select:not([data-control])').first().selectOption('aws');
  await page.waitForTimeout(400);

  const list = page.locator('select:not([data-control])').nth(1);
  const groups = await list.evaluate((s) =>
    Array.from(s.querySelectorAll('optgroup')).map((g) => `${g.label}:${g.children.length}`),
  );
  check(
    'Modules: the picker separates resources from module calls',
    groups.filter((g) => !g.startsWith('From your estate')).length === 2 &&
      groups.some((g) => g.startsWith('Terraform Registry modules')),
    groups.join(' | '),
  );

  const labels = await list.locator('option').allTextContents();
  const vpc = labels.findIndex((t) => /terraform-aws-modules\/vpc/.test(t));
  check('Modules: the VPC module is offered', vpc >= 0);
  await list.selectOption({ index: vpc });
  await page.waitForTimeout(400);

  // The answer sets apply to module inputs too, because a module input called
  // `cidr` is the same question as a resource argument called `cidr`.
  const cidr = page.locator('.field', { hasText: /VPC CIDR/i }).first();
  check(
    'Modules: an input with a known answer set still gets its dropdown',
    (await cidr.locator('select option').count()) > 5,
  );

  await page.locator('button', { hasText: 'Generate Terraform' }).click();
  await page.waitForTimeout(700);
  const body = await page.locator('body').innerText();
  check('Modules: it generates a module call', /module "vpc" \{/.test(body));
  check(
    'Modules: pinned to the version the catalog checked',
    /source\s+= "terraform-aws-modules\/vpc\/aws"/.test(body) && /version\s+= "~> \d/.test(body),
  );
  check('Modules: and reports no errors', /No errors/.test(body));
  check(
    'Modules: the catalog says how many modules it holds',
    /Module catalog holds \d+ registry modules/.test(body),
  );

  await ctx.close();
}

// --- a module's whole input table, and what the call will build ----------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/terraform.html`, { waitUntil: 'networkidle' });
  await page.locator('select:not([data-control])').first().selectOption('aws');
  await page.waitForTimeout(400);
  const list = page.locator('select:not([data-control])').nth(1);
  const labels = await list.locator('option').allTextContents();
  await list.selectOption({ index: labels.findIndex((t) => /ec2-instance/.test(t)) });
  await page.waitForTimeout(400);

  const summary = page.locator('.input-section > summary').first();
  check(
    'Module table: every input the module takes is offered',
    /All 83 inputs of terraform-aws-modules\/ec2-instance\/aws/.test(await summary.innerText()),
  );
  await summary.click();

  const help = await page.locator('.input-section .field-help').count();
  check('Module table: each input carries the module’s own description', help > 60, `${help} described`);

  await page.locator('.input-section-filter input').first().fill('spot');
  await page.waitForTimeout(200);
  const shown = await page.locator('.input-section .field:visible').count();
  check('Module table: and can be filtered', shown > 3 && shown < 20, `${shown} shown for "spot"`);

  // Untouched inputs must not end up in the file. Picking the first option of
  // a dropdown nobody opened is how create_spot_instance = true got written
  // into every call once.
  await page.locator('button', { hasText: 'Generate Terraform' }).click();
  await page.waitForTimeout(600);
  let body = await page.locator('body').innerText();
  const file = await page.locator('pre.code-block').first().innerText();
  check(
    'Module table: untouched inputs are left to the module',
    !/create_spot_instance|hibernation\s*=/.test(file),
  );
  check('Build plan: shows what the call will create', /What this will create/.test(body));
  check(
    'Build plan: the instance is created',
    (await page.locator('tr.build-yes', { hasText: 'aws_instance.this' }).count()) === 1,
  );

  await page.locator('.input-section .field', { hasText: 'create_spot_instance' }).locator('select').selectOption('true');
  await page.locator('button', { hasText: 'Generate Terraform' }).click();
  await page.waitForTimeout(600);
  body = await page.locator('body').innerText();
  check('Build plan: a touched input is written', /create_spot_instance\s*= true/.test(body));
  check(
    'Build plan: and changes what is built — a spot request instead of an instance',
    (await page.locator('tr.build-yes', { hasText: 'aws_spot_instance_request.this' }).count()) === 1 &&
      (await page.locator('tr.build-no', { hasText: 'aws_instance.this' }).count()) === 1,
  );

  await ctx.close();
}

// --- the Terraform Map: the reference the generator does not replace ------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/terraform-map.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const sections = await page.locator('.map-section').count();
  check('Map: AWS opens with its domains', sections >= 7, `${sections} sections`);
  check(
    'Map: and the AWS names all pass the catalog check',
    (await page.locator('.map-name.is-unknown').count()) === 0,
  );

  // Every cloud must render, and the marks on the page must agree with the
  // findings panel — a name flagged in one and not the other is the bug this
  // page exists to avoid making.
  for (const target of ['azure', 'google', 'oci']) {
    await page.locator('select:not([data-control])').first().selectOption(target);
    await page.waitForTimeout(400);
    const count = await page.locator('.map-section').count();
    check(`Map: ${target} renders its domains`, count >= 7, `${count} sections`);

    const marked = await page.locator('.map-name.is-unknown').count();
    const warned = await page.locator('.finding.is-warning').count();
    check(
      `Map: ${target} marks exactly what it reports`,
      marked === warned,
      `${marked} marked, ${warned} reported`,
    );
  }

  // The point of the check is the suggestion, not the complaint.
  await page.locator('select:not([data-control])').first().selectOption('azure');
  await page.waitForTimeout(400);
  const body = await page.locator('body').innerText();
  check(
    'Map: a stale name is told what replaced it',
    /azurerm_app_service_plan/.test(body) && /closest catalogued name is azurerm_service_plan/.test(body),
  );

  await ctx.close();
}

// --- the generators: platform once, then what to build -------------------
for (const [kind, path, generateLabel, expect] of [
  ['Terraform', '/app/terraform.html', 'Generate Terraform', /resource "aws_instance"/],
  ['Ansible', '/app/ansible.html', 'Generate Ansible', /amazon\.aws\.ec2_instance:/],
]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'networkidle' });

  // Step 1 is a dropdown, not a checkbox per cloud.
  const platform = page.locator('select:not([data-control])').first();
  const platforms = await platform.locator('option').count();
  check(`${kind}: one platform dropdown, not a checkbox each`, platforms >= 7, `${platforms} options`);
  check(
    `${kind}: no cloud checkboxes`,
    (await page.locator('input[type=checkbox]').count()) === 0,
  );

  await platform.selectOption('aws');
  await page.waitForTimeout(400);
  const blueprints = page.locator('select:not([data-control])').nth(1);
  const count = await blueprints.locator('option').count();
  check(`${kind}: AWS offers several things to build`, count >= 4, `${count} blueprints`);

  // Step 2 must use a dropdown for a one-of choice.
  const region = page.locator('.field', { hasText: 'region' }).locator('select').first();
  check(`${kind}: region is a dropdown`, (await region.count()) > 0);

  // The sized fields were a datalist once, which shows no arrow and no list
  // until you type — indistinguishable from an empty text box.
  const sized = page.locator('.field', { hasText: /instance type|machine type|vm size|shape/i }).first();
  const sizedOptions = await sized.locator('select option').count();
  check(`${kind}: the machine size is a dropdown with real choices`, sizedOptions > 5, `${sizedOptions} options`);
  check(
    `${kind}: and still lets you type one it has not heard of`,
    (await sized.locator('select option[value="__custom__"]').count()) === 1,
  );
  const regionText = (await region.locator('option').allTextContents()).join(' ');
  check(
    `${kind}: with the Gov and ISO regions, not just the commercial ones`,
    /us-gov-west-1/.test(regionText) && /us-iso-east-1/.test(regionText),
  );

  // A machine catalogue is thousands of entries, so it has to arrive grouped or
  // it is a scroll bar. The headings are the vendor's own categories.
  const sizeGroups = await sized.locator('select optgroup').allTextContents();
  const sizeLabels = await sized.evaluate((f) =>
    Array.from(f.querySelectorAll('select optgroup')).map((g) => g.label),
  );
  check(
    `${kind}: the machine list is grouped the way the vendor groups it`,
    sizeLabels.length >= 5 && sizeLabels.includes('General purpose'),
    sizeLabels.join(' | ').slice(0, 70),
  );
  check(
    `${kind}: and holds the whole catalogue, not a shortlist`,
    sizedOptions > 500,
    `${sizedOptions} options`,
  );
  void sizeGroups;

  // Credentials are references, not literals. The originals shipped CHANGEME as
  // the default, which is how one ends up committed.
  const secret = page.locator('.field', { hasText: /password/i }).first();
  if ((await secret.count()) > 0) {
    const secretValues = await secret.evaluate((f) =>
      Array.from(f.querySelectorAll('select option')).map((o) => o.value),
    );
    const wanted = kind === 'Terraform' ? /^var\./ : /\{\{/;
    check(
      `${kind}: a password field offers references rather than a literal`,
      secretValues.some((v) => wanted.test(v)) && !secretValues.some((v) => /CHANGEME/i.test(v)),
      secretValues.slice(0, 2).join(', '),
    );
  }

  // Step 3 is empty until asked.
  let body = await page.locator('body').innerText();
  check(`${kind}: nothing is generated until Generate is pressed`, /Idle/.test(body));

  await page.locator('button', { hasText: generateLabel }).click();
  await page.waitForTimeout(600);
  body = await page.locator('body').innerText();
  check(`${kind}: generates what the blueprint says`, expect.test(body));
  check(`${kind}: and reports no errors`, /No errors/.test(body));
  check(
    `${kind}: no literal credential in the output`,
    !/CHANGEME|ChangeMe123/.test(body),
  );
  check(
    `${kind}: with Copy and Download`,
    (await page.locator('button', { hasText: 'Copy' }).count()) > 0 &&
      (await page.locator('button', { hasText: 'Download' }).count()) > 0,
  );

  // Changing the blueprint must change the parameters.
  await blueprints.selectOption({ index: 1 });
  await page.waitForTimeout(500);
  const second = await page.locator('body').innerText();
  check(`${kind}: choosing another blueprint changes the parameters`, second !== body);
  await ctx.close();
}

// --- the platform is chosen once and carried ------------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/terraform.html`, { waitUntil: 'networkidle' });
  await page.locator('select:not([data-control])').first().selectOption('oci');
  await page.waitForTimeout(400);

  // Same tab, other generator: it must already be on OCI.
  await page.goto(`${BASE}/app/ansible.html`, { waitUntil: 'networkidle' });
  check(
    'the platform carries from one generator to the other',
    (await page.locator('select:not([data-control])').first().inputValue()) === 'oci',
  );
  await ctx.close();
}

// --- the decision wizard -------------------------------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}/app/multicloud.html`, { waitUntil: 'networkidle' });

  check('the wizard mounts without a script error', errors.length === 0, errors[0] ?? '');
  check('the cloud is chosen once, at the top', (await page.locator('#cloudProvider').count()) === 1);
  check('it opens on step 1', await page.locator('#step-1').isVisible());
  check('and only step 1', !(await page.locator('#step-2').isVisible()));

  const selects = await page.locator('select').count();
  check('the questions are dropdowns', selects > 30, `${selects} dropdowns`);
  check(
    'the F5 usage question is there, with all six answers',
    (await page.locator('input[name=f5Usage]').count()) === 6,
  );
  check(
    'the environments question is there, with all five',
    (await page.locator('input[name=envScope]').count()) === 5,
  );
  const hints = await page.locator('.field-hint').count();
  check('the questions keep their hints', hints > 20, `${hints} hints`);
  check(
    'and a step that has a sub-heading keeps it, which is what sets the field order',
    (await page.locator('#step-4 .field-group-title').innerText()) === 'Sizing & environments',
  );

  // Validation is advisory in the original — "soft validation only": it names
  // what is missing and lets you carry on, because a generic recommendation is
  // more use than a blocked form.
  await page.locator('#nextBtn').click();
  await page.waitForTimeout(300);
  check('moving on with answers missing says what will suffer', /Missing:/.test(await page.locator('#error-step-1').innerText()));
  check('and still lets you carry on', await page.locator('#step-2').isVisible());

  await page.locator('#backBtn').click();
  await page.waitForTimeout(200);
  await page.selectOption('#initiativeType', 'migration');
  await page.fill('#workloadName', 'Case Management');
  await page.locator('#nextBtn').click();
  await page.waitForTimeout(400);
  check('answering step 1 moves to step 2', await page.locator('#step-2').isVisible());
  check('picking an initiative type selects its questions', await page.locator('#path-migration').isVisible());
  check('and hides the others', !(await page.locator('#path-new-service').isVisible()));

  // Answer everything, then generate.
  await page.evaluate(() => {
    document.querySelectorAll('select').forEach((s) => {
      if (s.id === 'cloudProvider') return;
      if (s.options.length > 1) {
        s.selectedIndex = 1;
        s.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    document.querySelectorAll('input[type=text]').forEach((i) => {
      i.value = 'Case Management';
    });
    document.querySelectorAll('input[type=number]').forEach((i) => {
      i.value = '500';
    });
    document.querySelectorAll('textarea').forEach((t) => {
      t.value = 'Line-of-business application.';
    });
    document.querySelectorAll('input[name=envScope]').forEach((c) => {
      c.checked = true;
    });
  });
  await page.locator('button', { hasText: 'Generate recommendation' }).click();
  await page.waitForTimeout(900);

  const results = await page.locator('#resultsContent').innerText();
  check('generating produces a real recommendation', results.length > 3000, `${results.length} chars`);
  for (const [id, label] of [
    ['computeMain', 'compute pattern'],
    ['dataMain', 'data and storage'],
    ['securityMain', 'security controls'],
    ['controlsMain', 'the cyber checklist'],
    ['drPatternMain', 'the DR pattern'],
    ['sizingMatrix', 'the sizing matrix'],
    ['howToMain', 'the onboarding playbook'],
  ]) {
    const filled = (await page.locator(`#${id}`).innerText()).trim().length;
    check(`it fills in ${label}`, filled > 20, `${filled} chars`);
  }
  check(
    'the export buttons are live once there is something to export',
    !(await page.locator('#exportWordBtn').isDisabled()),
  );

  // Changing the cloud changes the recommendation.
  await page.selectOption('#cloudProvider', 'aws');
  await page.locator('button', { hasText: 'Generate recommendation' }).click();
  await page.waitForTimeout(700);
  const aws = await page.locator('#computeMain').innerText();
  check('changing the cloud changes what is recommended', /EC2|AWS/i.test(aws), aws.slice(0, 60));

  // And it reaches the generators without being retyped.
  await page.goto(`${BASE}/app/terraform.html`, { waitUntil: 'networkidle' });
  check(
    'the wizard tells the generators which cloud to open on',
    (await page.locator('select:not([data-control])').first().inputValue()) === 'aws',
  );
  check(
    'and the generator says where that came from',
    /chosen in the decision wizard/.test(await page.locator('body').innerText()),
  );
  await ctx.close();
}

// --- the 7R migration engine ---------------------------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${BASE}/app/migration.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  check('the migration workspace loads clean', errors.length === 0, errors[0] ?? '');
  check(
    'the shared service catalog loads with it',
    (await page.evaluate(() => typeof window.CDK)) === 'object',
  );
  const tabs = (await page.locator('.tab').allTextContents()).join(' ');
  check('it keeps its five tabs', /Manual.*Intake.*Ratings.*Results.*Playbooks/s.test(tabs), tabs);

  await page.locator('.tab', { hasText: 'Intake' }).click();
  await page.waitForTimeout(200);
  await page.fill('#appName', 'Case Management System');
  await page.fill('#appOwner', 'Platform Team');
  await page.selectOption('#criticality', 'Mission Critical');
  await page.fill('#rto', '4');
  await page.fill('#rpo', '1');
  await page.selectOption('#enterpriseCloud', 'Azure');

  await page.locator('#btnRun').click();
  await page.waitForTimeout(700);
  await page.locator('.tab', { hasText: 'Results' }).click();
  await page.waitForTimeout(300);

  const results = await page.locator('#sec-results').innerText();
  check('it routes the application to one of the 7 Rs', /Rehost|Replatform|Refactor|Repurchase|Retain|Retire|Relocate/.test(results), results.slice(0, 40).replace(/\n/g, ' '));
  check('it scores readiness', /Readiness Score/.test(results));
  check('it names the target cloud it planned for', /AZURE/i.test(results));
  check('and produces a step-by-step plan for that cloud', /Azure Landing Zone|Entra ID/.test(results));
  check('with a risk badge', (await page.locator('#sec-results .badge').count()) > 0);
  await ctx.close();
}

// --- the imported estate fills the vSphere dropdowns ----------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Import an estate, then ask a generator for vSphere. The blueprints should
  // be offering these names rather than a box with "datastore1" in it.
  await page.goto(`${BASE}/app/inventory.html`, { waitUntil: 'networkidle' });
  await page.locator('.estate-bar input[type=file]').setInputFiles(fixture);
  await page.waitForFunction(() => /Estate:/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => undefined);

  for (const [kind, path] of [
    ['Terraform', '/app/terraform.html'],
    ['Ansible', '/app/ansible.html'],
  ]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.locator('select:not([data-control])').first().selectOption('vsphere');
    await page.waitForTimeout(400);

    const offered = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('.field').forEach((f) => {
        const label = (f.querySelector('label') || {}).textContent || '';
        const select = f.querySelector('.combo select');
        if (!select) return;
        out[label.trim()] = Array.from(select.options).map((o) => o.value);
      });
      return out;
    });
    const all = Object.values(offered).flat();
    check(
      `${kind}: vSphere fields offer the imported estate`,
      all.includes('Cluster01'),
      Object.keys(offered).join(', ').slice(0, 70),
    );
    check(
      `${kind}: and say where the names came from`,
      /From estate\.xlsx/.test(await page.locator('body').innerText()),
    );
  }
  await ctx.close();
}

await browser.close();
stop();

console.log(failures === 0 ? '\nBrowser checks passed.' : `\n${failures} browser check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

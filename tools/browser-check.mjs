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

// --- every page mounts without a console error ----------------------------
for (const [name, path] of [
  ['index', '/'],
  ['inventory', '/app/inventory.html'],
  ['sizing', '/app/vcf-sizing.html'],
  ['spec', '/app/vcf-spec.html'],
  ['terraform', '/app/terraform.html'],
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

// --- the whole chain, from an imported estate to a document ---------------
{
  // Four hosts, one deliberately smaller: the weakest host is what sets the
  // per-host profile, so seeing 512 downstream proves the estate really drove
  // the sizing rather than a default coming through.
  const estate = {
    source: { kind: 'powercli', label: 'browser-check' },
    hosts: [768, 768, 512, 768].map((memoryGib, i) => ({
      name: `esx0${i + 1}.check.local`,
      cluster: 'Check-Cluster',
      cpuSockets: 2,
      coresPerSocket: 24,
      totalCores: 48,
      threads: 96,
      memoryGib,
      nicCount: 4,
      esxVersion: '8.0.3',
    })),
    vms: [
      { name: 'app01', vcpu: 8, memoryGib: 32, provisionedGib: 300, usedGib: 180, powerState: 'PoweredOn' },
      { name: 'db01', vcpu: 32, memoryGib: 256, provisionedGib: 2000, usedGib: 1600, powerState: 'PoweredOn' },
    ],
    clusters: [{ name: 'Check-Cluster', datacenter: 'DC1', haEnabled: true, drsEnabled: true, hostCount: 4 }],
    datastores: [{ name: 'vsanDatastore', type: 'vsan', capacityGib: 40960, freeGib: 18000, hostCount: 4 }],
    networks: [{ name: 'VM Network', switchName: 'DSwitch', vlanId: 100, type: 'DistributedPortgroup' }],
  };
  const fixture = join(mkdtempSync(join(tmpdir(), 'atk-')), 'estate.json');
  writeFileSync(fixture, JSON.stringify(estate));

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/inventory.html`, { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.waitForTimeout(1200);

  check(
    'an imported estate produces a sizing bridge',
    /As a VCF target/i.test(await page.locator('body').innerText()),
  );

  await page.locator('button', { hasText: 'Continue in sizing' }).click();
  await page.waitForTimeout(1500);
  check('inventory hands over to sizing', page.url().endsWith('/vcf-sizing.html'));
  check(
    'sizing says where its values came from',
    (await page.locator('text=Prefilled from your inventory').count()) === 1,
  );
  const ram = await page
    .locator('.field', { hasText: 'RAM (GiB)' })
    .locator('input')
    .first()
    .inputValue();
  check('the weakest host set the per-host profile', ram === '512', `got ${ram}`);

  await page.locator('button', { hasText: 'Continue in the spec' }).click();
  await page.waitForTimeout(1500);
  check('sizing hands over to the spec builder', page.url().endsWith('/vcf-spec.html'));
  check(
    'a document comes out the far end',
    /"sddcId"/.test(await page.locator('body').innerText()),
  );
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

// --- the Terraform kit generates for every cloud --------------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/terraform.html`, { waitUntil: 'networkidle' });

  const boxes = page.locator('input[type=checkbox]');
  const count = await boxes.count();
  for (let i = 0; i < count; i += 1) {
    if (!(await boxes.nth(i).isChecked())) await boxes.nth(i).check();
  }
  await page.waitForTimeout(600);
  let body = await page.locator('body').innerText();

  check('AWS emits a VPC', /aws_vpc/.test(body));
  check('Azure emits a virtual network', /azurerm_virtual_network/.test(body));
  check('Google builds a custom-mode VPC', /auto_create_subnetworks = false/.test(body));
  check('vSphere emits a distributed switch', /vsphere_distributed_virtual_switch/.test(body));
  // Every OCI resource needs a compartment, so it refuses until one is given.
  check('OCI refuses without a compartment', /compartment OCID/i.test(body));
  check(
    'VCF points at the spec builder rather than doing nothing',
    /specification rather than a network foundation/i.test(body),
  );

  await page
    .locator('.field', { hasText: 'OCI compartment OCID' })
    .locator('input')
    .first()
    .fill('ocid1.compartment.oc1..aaaa');
  await page.waitForTimeout(600);
  body = await page.locator('body').innerText();
  check('OCI emits once a compartment is supplied', /oci_core_vcn/.test(body));
  // OCI takes IP protocol numbers as strings; "tcp" is rejected.
  check('OCI writes TCP as protocol 6', /protocol\s+= "6"/.test(body));

  await page
    .locator('.field', { hasText: 'Address space' })
    .locator('input')
    .first()
    .fill('10.90.0.0/16');
  await page.waitForTimeout(700);
  body = await page.locator('body').innerText();
  check('a new address space reaches every cloud', /10\.90\.0\.0\/16/.test(body));
  check('subnets are carved from it', /10\.90\.1\.0\/24/.test(body));
  check(
    'buttons survive an edit',
    (await page.locator('button', { hasText: 'Download as one file' }).count()) > 0,
  );
  await ctx.close();
}

await browser.close();
stop();

console.log(failures === 0 ? '\nBrowser checks passed.' : `\n${failures} browser check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

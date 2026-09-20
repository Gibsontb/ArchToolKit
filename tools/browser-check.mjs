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

/** Shared estate fixture, built by the sizing-bridge block and reused after it. */
let estate;
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
  estate = {
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
  fixture = join(mkdtempSync(join(tmpdir(), 'atk-')), 'estate.json');
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

// --- the generators: platform once, then what to build -------------------
for (const [kind, path, generateLabel, expect] of [
  ['Terraform', '/app/terraform.html', 'Generate Terraform', /resource "aws_instance"/],
  ['Ansible', '/app/ansible.html', 'Generate Ansible', /amazon\.aws\.ec2_instance:/],
]) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: 'networkidle' });

  // Step 1 is a dropdown, not a checkbox per cloud.
  const platform = page.locator('select').first();
  const platforms = await platform.locator('option').count();
  check(`${kind}: one platform dropdown, not a checkbox each`, platforms >= 7, `${platforms} options`);
  check(
    `${kind}: no cloud checkboxes`,
    (await page.locator('input[type=checkbox]').count()) === 0,
  );

  await platform.selectOption('aws');
  await page.waitForTimeout(400);
  const blueprints = page.locator('select').nth(1);
  const count = await blueprints.locator('option').count();
  check(`${kind}: AWS offers several things to build`, count >= 4, `${count} blueprints`);

  // Step 2 must use a dropdown for a one-of choice.
  const region = page.locator('.field', { hasText: 'region' }).locator('select').first();
  check(`${kind}: region is a dropdown`, (await region.count()) > 0);
  const regionText = (await region.locator('option').allTextContents()).join(' ');
  check(
    `${kind}: with the Gov and ISO regions, not just the commercial ones`,
    /us-gov-west-1/.test(regionText) && /us-iso-east-1/.test(regionText),
  );

  // Step 3 is empty until asked.
  let body = await page.locator('body').innerText();
  check(`${kind}: nothing is generated until Generate is pressed`, /Idle/.test(body));

  await page.locator('button', { hasText: generateLabel }).click();
  await page.waitForTimeout(600);
  body = await page.locator('body').innerText();
  check(`${kind}: generates what the blueprint says`, expect.test(body));
  check(`${kind}: and reports no errors`, /No errors/.test(body));
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
  await page.locator('select').first().selectOption('oci');
  await page.waitForTimeout(400);

  // Same tab, other generator: it must already be on OCI.
  await page.goto(`${BASE}/app/ansible.html`, { waitUntil: 'networkidle' });
  check(
    'the platform carries from one generator to the other',
    (await page.locator('select').first().inputValue()) === 'oci',
  );
  await ctx.close();
}

// --- the matrix decides the platform, and the generators follow -----------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/multicloud.html`, { waitUntil: 'networkidle' });
  await page
    .locator('.card', { hasText: 'Already committed to' })
    .locator('label', { hasText: 'Azure' })
    .locator('input')
    .first()
    .check();
  await page
    .locator('.card', { hasText: 'Team can operate' })
    .locator('label', { hasText: 'Azure' })
    .locator('input')
    .first()
    .check();
  await page.waitForTimeout(700);

  await page.goto(`${BASE}/app/ansible.html`, { waitUntil: 'networkidle' });
  check(
    'a decision reaches the generator without being retyped',
    (await page.locator('select').first().inputValue()) === 'azure',
  );
  check(
    'and the generator says where the platform came from',
    /set by the decision matrix/.test(await page.locator('body').innerText()),
  );
  await ctx.close();
}

// --- the multi-cloud matrix ranks, explains, and hands off ----------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/multicloud.html`, { waitUntil: 'networkidle' });
  let body = await page.locator('body').innerText();

  check('every platform is ranked', /VMware Cloud Foundation/.test(body) && /Oracle Cloud Infrastructure/.test(body));
  check('the capability matrix renders', /Object storage/.test(body) && /Amazon S3/.test(body));
  check('the VMware services carry provenance', /Amazon EVS/.test(body) && /Azure VMware Solution/.test(body));
  check('an unconfirmed claim says so', /not confirmed/i.test(body));

  // A latency-critical workload must not leave the data centre.
  const latency = page.locator('.field', { hasText: 'Latency to what stays behind' }).locator('select').first();
  await latency.selectOption({ index: 2 });
  await page.waitForTimeout(700);
  body = await page.locator('body').innerText();
  check('latency-critical keeps the workload on owned hardware', /recommended/.test(body));
  check('and says to measure it rather than assume', /Measure the actual round trip/.test(body));

  await latency.selectOption({ index: 0 });
  await page.waitForTimeout(500);

  // A physical dongle rules out every cloud, and the page must show that.
  const dongle = page.locator('label', { hasText: 'Physical licence dongle' }).locator('input').first();
  await dongle.check();
  await page.waitForTimeout(700);
  body = await page.locator('body').innerText();
  const ruledOut = (body.match(/ruled out/g) ?? []).length;
  check('a physical dongle rules out all four clouds', ruledOut >= 4, `${ruledOut} ruled out`);
  await dongle.uncheck();
  await page.waitForTimeout(500);

  // Oracle must not simply route to OCI any more.
  await page.locator('label', { hasText: 'Oracle Database' }).locator('input').first().check();
  await page.waitForTimeout(700);
  body = await page.locator('body').innerText();
  check('Oracle no longer forces OCI', /no longer forces OCI/.test(body));
  check('and the region constraint is reported', /available only in specific regions/.test(body));

  // A decision has to become something.
  const commitAws = page
    .locator('.card', { hasText: 'Already committed to' })
    .locator('label', { hasText: 'AWS' })
    .locator('input')
    .first();
  await commitAws.check();
  const skillAws = page
    .locator('.card', { hasText: 'Team can operate' })
    .locator('label', { hasText: 'AWS' })
    .locator('input')
    .first();
  await skillAws.check();
  await page.waitForTimeout(800);
  body = await page.locator('body').innerText();
  check('a clear winner produces a handoff', /What to generate next/.test(body));
  check('and names its VMware service for a rehost', /Amazon EVS/.test(body));

  await page.locator('button', { hasText: 'Terraform for AWS' }).click();
  await page.waitForTimeout(1200);
  check('the handoff button reaches the Terraform page', page.url().endsWith('/terraform.html'));
  await ctx.close();
}

// --- the inventory hands an estate to the decision matrix ------------------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/app/inventory.html`, { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.waitForTimeout(1200);
  const decide = page.locator('button', { hasText: 'Decide where it goes' });
  check('the inventory page offers the decision matrix', (await decide.count()) === 1);
  if ((await decide.count()) === 1) {
    await decide.click();
    await page.waitForTimeout(1500);
    check('it reaches the matrix', page.url().endsWith('/multicloud.html'));
    const body = await page.locator('body').innerText();
    check('the estate arrives prefilled', /Prefilled from your inventory/.test(body));
    check('and the counts come with it', /virtual machines:/.test(body));

    await page.reload({ waitUntil: 'networkidle' });
    const after = await page.locator('body').innerText();
    check('reloading does not re-apply a spent handoff', !/Prefilled from your inventory/.test(after));
  }
  await ctx.close();
}

await browser.close();
stop();

console.log(failures === 0 ? '\nBrowser checks passed.' : `\n${failures} browser check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

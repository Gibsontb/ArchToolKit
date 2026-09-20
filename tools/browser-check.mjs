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
      t.value = 'Court case management system.';
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
    (await page.locator('select').first().inputValue()) === 'aws',
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
  await page.fill('#appOwner', 'Courts IT');
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
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.waitForTimeout(1200);

  for (const [kind, path] of [
    ['Terraform', '/app/terraform.html'],
    ['Ansible', '/app/ansible.html'],
  ]) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.locator('select').first().selectOption('vsphere');
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
      all.includes('Check-Cluster'),
      Object.keys(offered).join(', ').slice(0, 70),
    );
    check(
      `${kind}: and say where the names came from`,
      /browser-check/.test(await page.locator('body').innerText()),
    );
  }
  await ctx.close();
}

await browser.close();
stop();

console.log(failures === 0 ? '\nBrowser checks passed.' : `\n${failures} browser check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

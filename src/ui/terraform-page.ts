/**
 * Terraform authoring page.
 *
 * Describe a network once, choose the clouds, and read what each provider wants
 * it to look like. The value is less in saving typing than in seeing the same
 * design rendered five ways at once, where the differences that matter stop
 * being naming and start being behaviour — Google needing a NAT for a subnet
 * that has no outbound path, OCI refusing to exist outside a compartment.
 */

import { el, append, replace, downloadFile } from './dom.ts';
import { card, field, findingsList, numberInput, select, checkbox } from './components.ts';
import {
  scaffold,
  emitFoundation,
  searchCatalog,
  catalogFindings,
  catalogTotals,
  catalogued,
  PROVIDERS,
  type CloudTarget,
  type FoundationPlan,
  type BackendKind,
} from '../terraform/index.ts';
import type { Finding } from '../core/findings.ts';

/** Local, as on the other pages: components.ts exposes no text input. */
function textInput(value: string, placeholder = ''): HTMLInputElement {
  const node = el('input', { attrs: { type: 'text', value, placeholder } }) as HTMLInputElement;
  node.value = value;
  return node;
}

interface Controls {
  name: HTMLInputElement;
  cidr: HTMLInputElement;
  region: HTMLInputElement;
  subnetCount: HTMLInputElement;
  publicSubnets: HTMLInputElement;
  ingressCidrs: HTMLInputElement;
  ingressPorts: HTMLInputElement;
  compartmentId: HTMLInputElement;
  datacenter: HTMLInputElement;
  cluster: HTMLInputElement;
  backend: HTMLSelectElement;
  catalogQuery: HTMLInputElement;
  targets: Partial<Record<CloudTarget, HTMLInputElement>>;
}

const BACKENDS: { value: BackendKind; label: string }[] = [
  { value: 'local', label: 'Local (one machine, no locking)' },
  { value: 's3', label: 'AWS S3' },
  { value: 'azurerm', label: 'Azure Storage' },
  { value: 'gcs', label: 'Google Cloud Storage' },
  { value: 'oci', label: 'OCI Object Storage' },
  { value: 'none', label: 'None' },
];

function list(input: HTMLInputElement): string[] {
  return input.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Carve the address space into equal subnets.
 *
 * Only the common case — a /16 split into /24s — is handled properly; anything
 * else keeps the parent prefix and is reported, rather than emitting arithmetic
 * that looks authoritative and is wrong.
 */
function deriveSubnets(
  cidr: string,
  count: number,
  publicCount: number,
): { subnets: FoundationPlan['subnets']; exact: boolean } {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr.trim());
  if (!match) return { subnets: [], exact: false };
  const [, a, b, , , prefixText] = match;
  const prefix = Number(prefixText);
  const exact = prefix <= 24;

  const subnets = Array.from({ length: Math.max(1, count) }, (_, i) => {
    const isPublic = i < publicCount;
    const name = isPublic ? `public-${i + 1}` : `private-${i - publicCount + 1}`;
    const third = exact ? i + 1 : 0;
    return {
      name,
      cidr: exact ? `${a}.${b}.${third}.0/24` : cidr,
      ...(isPublic ? { public: true } : {}),
    };
  });
  return { subnets, exact };
}

export function mountTerraformPage(root: HTMLElement): void {
  const controls = { targets: {} } as Controls;
  const outputPane = el('div', { class: 'stack' });
  const inputsPane = buildInputs(controls, () => render());

  append(root, el('div', { class: 'split' }, el('div', {}, inputsPane), outputPane));

  let lastRenderKey = '';

  function currentPlan(): { plan: FoundationPlan; exact: boolean } {
    const count = Math.max(1, Number(controls.subnetCount.value) || 2);
    const publicCount = Math.min(count, Math.max(0, Number(controls.publicSubnets.value) || 0));
    const { subnets, exact } = deriveSubnets(controls.cidr.value, count, publicCount);
    return {
      exact,
      plan: {
        name: controls.name.value.trim() || 'core',
        cidr: controls.cidr.value.trim() || '10.20.0.0/16',
        subnets,
        region: controls.region.value.trim() || undefined,
        allowedIngressCidrs: list(controls.ingressCidrs),
        allowedTcpPorts: list(controls.ingressPorts)
          .map(Number)
          .filter((n) => Number.isFinite(n)),
        compartmentId: controls.compartmentId.value.trim() || undefined,
        datacenter: controls.datacenter.value.trim() || undefined,
        cluster: controls.cluster.value.trim() || undefined,
      },
    };
  }

  function selectedTargets(): CloudTarget[] {
    return (Object.entries(controls.targets) as [CloudTarget, HTMLInputElement][])
      .filter(([, input]) => input.checked)
      .map(([target]) => target);
  }

  function render(): void {
    const { plan, exact } = currentPlan();
    const targets = selectedTargets();
    const backend = controls.backend.value as BackendKind;
    const query = controls.catalogQuery.value.trim();
    const key = JSON.stringify({ plan, targets, backend, query });
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    const sections: HTMLElement[] = [];
    const allFindings: Finding[] = [];

    const sc = scaffold({ targets, backend, projectName: plan.name });
    allFindings.push(...sc.findings);
    if (Object.keys(sc.files).length > 0) {
      sections.push(fileCard('Scaffold', sc.files, `${plan.name}-scaffold`));
    }

    for (const target of targets) {
      // VCF is dispatched too, even though it has no foundation: it answers with
      // a finding pointing at the spec builder, and silently skipping it would
      // leave someone who selected it wondering why nothing happened.
      const out = emitFoundation(target, plan);
      allFindings.push(...out.findings);
      if (Object.keys(out.files).length > 0) {
        const label = PROVIDERS.find((p) => p.target === target)?.label ?? target;
        sections.push(fileCard(`${label} foundation`, out.files, `${plan.name}-${target}`));
      }
    }

    if (!exact) {
      sections.unshift(
        el('div', {
          class: 'section-note',
          text: 'Subnets could not be carved from that address space, so each one repeats the parent range. Use a /16 or wider to have /24s derived.',
        }),
      );
    }

    if (targets.length === 0) {
      sections.push(
        card('Nothing selected', el('p', { text: 'Choose at least one cloud to generate for.' })),
      );
    }

    // The catalog answers "does this resource exist", which is a different
    // question from "what should I generate", so it gets its own section.
    if (query.length > 1) {
      // Searched across every catalogued provider rather than the current
      // selection: this is a reference for looking a resource up, and scoping it
      // to the selection made it answer "nothing" whenever the chosen cloud
      // happened not to be catalogued yet, with no hint as to why.
      const hits = searchCatalog(query, { limit: 60 });
      const totals = catalogTotals();
      const uncatalogued = targets.filter((t) => !catalogued().includes(t));
      sections.push(
        card(
          `Catalog — ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
          hits.length === 0
            ? el('p', {
                text:
                  `Nothing matched "${query}" in ${totals.resources} resources and ${totals.dataSources} data sources across ${catalogued().length} catalogued provider(s).` +
                  (uncatalogued.length > 0
                    ? ` ${uncatalogued.join(', ')} are not catalogued yet — run npm run catalog:update.`
                    : ''),
              })
            : el(
                'ul',
                { class: 'finding-list' },
                ...hits.map((hit) =>
                  el(
                    'li',
                    {},
                    el('code', { text: hit.type }),
                    el('span', { class: 'muted', text: `  ${hit.kind}` }),
                  ),
                ),
              ),
        ),
      );
    }

    allFindings.push(...catalogFindings());
    sections.push(card('Findings', findingsList(allFindings, 'Nothing to report.')));
    replace(outputPane, ...sections);
  }

  render();
}

function fileCard(
  title: string,
  files: Readonly<Record<string, string>>,
  downloadPrefix: string,
): HTMLElement {
  const children: HTMLElement[] = [];
  for (const [name, body] of Object.entries(files)) {
    children.push(
      el('div', { class: 'section-note', style: { marginTop: 'var(--space-3)' } }, el('strong', { text: name })),
      el(
        'pre',
        {
          class: 'mono',
          style: { margin: '0', padding: 'var(--space-4)', fontSize: '0.78rem', lineHeight: '1.5' },
        },
        body,
      ),
    );
  }
  children.push(
    el(
      'div',
      { class: 'btn-row', style: { marginTop: 'var(--space-4)' } },
      el('button', {
        class: 'btn',
        text: 'Download as one file',
        on: {
          click: () =>
            downloadFile(
              `${downloadPrefix}.tf.txt`,
              Object.entries(files)
                .map(([name, body]) => `# ===== ${name} =====\n${body}`)
                .join('\n'),
            ),
        },
      }),
    ),
  );
  return card(title, ...children);
}

function buildInputs(controls: Controls, onChange: () => void): HTMLElement {
  const bind = <T extends HTMLElement>(node: T): T => {
    node.addEventListener('change', onChange);
    node.addEventListener('input', onChange);
    return node;
  };

  controls.name = bind(textInput('core', 'Prefix for every generated name'));
  controls.cidr = bind(textInput('10.20.0.0/16'));
  controls.region = bind(textInput('', 'Cloud region; each provider has its own naming'));
  controls.subnetCount = bind(numberInput(3, { min: 1, max: 16 }));
  controls.publicSubnets = bind(numberInput(1, { min: 0, max: 16 }));
  controls.ingressCidrs = bind(textInput('10.0.0.0/8', 'Comma separated'));
  controls.ingressPorts = bind(textInput('443', 'Comma separated TCP ports'));
  controls.compartmentId = bind(textInput('', 'OCI compartment OCID'));
  controls.datacenter = bind(textInput('', 'vSphere datacenter'));
  controls.cluster = bind(textInput('', 'vSphere cluster'));
  controls.backend = bind(select(BACKENDS, 'local'));
  controls.catalogQuery = bind(textInput('', 'Search every resource, e.g. "bucket" or "virtual switch"'));

  const targetBoxes = PROVIDERS.map((provider) => {
    const box = checkbox(provider.label, provider.target === 'aws');
    controls.targets[provider.target] = bind(box.input);
    return el('div', { class: 'field' }, box.wrap);
  });

  return el(
    'div',
    { class: 'stack' },
    card('Clouds', ...targetBoxes),
    card(
      'Network',
      field('Name', controls.name),
      field('Address space', controls.cidr, 'A /16 is split into /24 subnets.'),
      field('Region', controls.region),
      el(
        'div',
        { class: 'field-row' },
        field('Subnets', controls.subnetCount),
        field('Of which public', controls.publicSubnets),
      ),
    ),
    card(
      'Access',
      field('Allowed inbound CIDRs', controls.ingressCidrs),
      field('Allowed TCP ports', controls.ingressPorts),
    ),
    card(
      'Per-cloud detail',
      field('OCI compartment OCID', controls.compartmentId, 'Required before OCI emits anything.'),
      el(
        'div',
        { class: 'field-row' },
        field('vSphere datacenter', controls.datacenter),
        field('vSphere cluster', controls.cluster),
      ),
    ),
    card('State', field('Backend', controls.backend)),
    card(
      'Resource catalog',
      field('Search', controls.catalogQuery, 'Names come from the Terraform Registry.'),
    ),
  );
}

const root = document.getElementById('terraform-root');
if (root) mountTerraformPage(root);

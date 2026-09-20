/**
 * Terraform authoring page.
 *
 * Describe a network once, choose the clouds, and read what each provider wants
 * it to look like. The value is less in saving typing than in seeing the same
 * design rendered five ways at once, where the differences that matter stop
 * being naming and start being behaviour — Google needing a NAT for a subnet
 * that has no outbound path, OCI refusing to exist outside a compartment.
 */

import { el, append, replace, downloadFile } from './dom.js';
import { card, field, findingsList, numberInput, select, checkbox } from './components.js';
import {
  scaffold,
  emitFoundation,
  PROVIDERS,
                   
                      
                   
} from '../terraform/index.js';
                                                   

/** Local, as on the other pages: components.ts exposes no text input. */
function textInput(value        , placeholder = '')                   {
  const node = el('input', { attrs: { type: 'text', value, placeholder } })                    ;
  node.value = value;
  return node;
}

                    
                         
                         
                           
                                
                                  
                                 
                                 
                                  
                               
                            
                             
                                                          
 

const BACKENDS                                          = [
  { value: 'local', label: 'Local (one machine, no locking)' },
  { value: 's3', label: 'AWS S3' },
  { value: 'azurerm', label: 'Azure Storage' },
  { value: 'gcs', label: 'Google Cloud Storage' },
  { value: 'oci', label: 'OCI Object Storage' },
  { value: 'none', label: 'None' },
];

function list(input                  )           {
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
  cidr        ,
  count        ,
  publicCount        ,
)                                                         {
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

export function mountTerraformPage(root             )       {
  const controls = { targets: {} }            ;
  const outputPane = el('div', { class: 'stack' });
  const inputsPane = buildInputs(controls, () => render());

  append(root, el('div', { class: 'split' }, el('div', {}, inputsPane), outputPane));

  let lastRenderKey = '';

  function currentPlan()                                           {
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

  function selectedTargets()                {
    return (Object.entries(controls.targets)                                     )
      .filter(([, input]) => input.checked)
      .map(([target]) => target);
  }

  function render()       {
    const { plan, exact } = currentPlan();
    const targets = selectedTargets();
    const backend = controls.backend.value               ;
    const key = JSON.stringify({ plan, targets, backend });
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    const sections                = [];
    const allFindings            = [];

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

    sections.push(card('Findings', findingsList(allFindings, 'Nothing to report.')));
    replace(outputPane, ...sections);
  }

  render();
}

function fileCard(
  title        ,
  files                                  ,
  downloadPrefix        ,
)              {
  const children                = [];
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

function buildInputs(controls          , onChange            )              {
  const bind =                        (node   )    => {
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
  );
}

const root = document.getElementById('terraform-root');
if (root) mountTerraformPage(root);

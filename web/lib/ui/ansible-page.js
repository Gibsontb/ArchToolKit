/**
 * Ansible authoring page.
 *
 * Terraform builds an estate; Ansible reads one and reconfigures it. So this
 * page has two halves. The scaffold is the repository spine for whichever
 * platforms are in play — collections, configuration, inventory and a vault
 * that is gitignored until it is encrypted. The vSphere half generates real
 * playbooks: one that collects an estate into JSON the inventory importer can
 * read, and one that renders the cluster settings an imported inventory already
 * holds as the tasks that would produce them.
 *
 * No credential is ever written into a generated file. Every vmware.vmware
 * module falls back to VMWARE_HOST, VMWARE_USER and VMWARE_PASSWORD, so the
 * playbooks name none of them and still run.
 */

import { el, append, replace, downloadFile } from './dom.js';
import { card, field, findingsList, select, checkbox } from './components.js';
import {
  scaffoldAnsible,
  emitInventoryCollection,
  emitClusterConfiguration,
  searchModules,
  catalogFindings,
  catalogTotals,
  catalogued,
  COLLECTIONS,
                     
} from '../ansible/index.js';
                                                   
                                                               

/** Local, as on the other pages: components.ts exposes no text input. */
function textInput(value        , placeholder = '')                   {
  const node = el('input', { attrs: { type: 'text', value, placeholder } })                    ;
  node.value = value;
  return node;
}

const TARGETS                                            = [
  { value: 'vmware', label: 'VMware vSphere' },
  { value: 'aws', label: 'Amazon Web Services' },
  { value: 'azure', label: 'Microsoft Azure' },
  { value: 'google', label: 'Google Cloud' },
  { value: 'oci', label: 'Oracle Cloud Infrastructure' },
  { value: 'posix', label: 'Linux hosts' },
  { value: 'windows', label: 'Windows hosts' },
  { value: 'general', label: 'Community general' },
];

const VALIDATE_CERTS                                     = [
  { value: 'default', label: "Module default (validate) — don't write the argument" },
  { value: 'true', label: 'Validate explicitly' },
  { value: 'false', label: 'Skip validation (self-signed lab certificate only)' },
];

                    
                                
                               
                              
                                   
                                 
                             
                                
                                                            
 

/**
 * Clusters typed into the box, as the inventory model sees them.
 *
 * The page cannot read an inventory the VMware page holds in another tab, so
 * this is the manual path: `name:ha:drs:level`, with anything omitted left
 * genuinely unset rather than defaulted — because an unset field is what stops
 * the generator turning missing data into a change.
 */
function parseClusters(text        , datacenter        )                     {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, ha, drs, level] = entry.split(':').map((s) => s.trim());
      const flag = (value                    )                      =>
        value === undefined || value === '' ? undefined : /^(y|yes|true|on|1)$/i.test(value);
      return {
        name: name ?? 'cluster',
        datacenter,
        ...(flag(ha) !== undefined ? { haEnabled: flag(ha) } : {}),
        ...(flag(drs) !== undefined ? { drsEnabled: flag(drs) } : {}),
        ...(level ? { drsAutomationLevel: level } : {}),
      };
    });
}

export function mountAnsiblePage(root             )       {
  const controls = { targets: {} }            ;
  const outputPane = el('div', { class: 'stack' });
  let lastRenderKey = '';

  const inputsPane = buildInputs(controls, () => render());
  append(root, el('div', { class: 'split' }, el('div', {}, inputsPane), outputPane));

  function selectedTargets()                  {
    return (Object.entries(controls.targets)                                       )
      .filter(([, input]) => input.checked)
      .map(([target]) => target);
  }

  function render()       {
    const targets = selectedTargets();
    const datacenter = controls.datacenter.value.trim() || 'datacenter-01';
    const outputDirectory = controls.outputDir.value.trim() || './collected';
    const certs = controls.validateCerts.value;
    const legacy = controls.legacyVmware.checked;
    const clusterText = controls.clusters.value;
    const query = controls.moduleQuery.value.trim();
    const projectName = controls.projectName.value.trim() || 'Ansible configuration';

    const key = JSON.stringify({ targets, datacenter, outputDirectory, certs, legacy, clusterText, query, projectName });
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    const sections                = [];
    const allFindings            = [];

    const sc = scaffoldAnsible({ targets, projectName, includeLegacyVmware: legacy });
    allFindings.push(...sc.findings);
    if (Object.keys(sc.files).length > 0) {
      sections.push(fileCard('Repository scaffold', sc.files, `${projectName}-ansible`));
    }

    if (targets.includes('vmware')) {
      const vmwareOptions = {
        datacenter,
        outputDirectory,
        ...(certs === 'default' ? {} : { validateCerts: certs === 'true' }),
      };

      const collect = emitInventoryCollection(vmwareOptions);
      allFindings.push(...collect.findings);
      sections.push(fileCard('Collect the estate', { 'collect.yml': collect.yaml }, 'collect'));

      const clusters = parseClusters(clusterText, datacenter);
      const config = emitClusterConfiguration(clusters, vmwareOptions);
      allFindings.push(...config.findings);
      if (config.yaml) {
        sections.push(fileCard('Cluster configuration', { 'clusters.yml': config.yaml }, 'clusters'));
      }
    }

    if (targets.length === 0) {
      sections.push(
        card('Nothing selected', el('p', { text: 'Choose at least one platform to generate for.' })),
      );
    }

    // The catalog answers "does this module exist", which is a different
    // question from "what should I generate", so it gets its own section, and
    // searches every catalogued collection rather than only the selected ones.
    if (query.length > 1) {
      const hits = searchModules(query, { limit: 60 });
      const totals = catalogTotals();
      sections.push(
        card(
          `Modules — ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
          hits.length === 0
            ? el('p', {
                text: `Nothing matched "${query}" in ${totals.modules} modules across ${catalogued().length} collection(s).`,
              })
            : el(
                'ul',
                { class: 'finding-list' },
                ...hits.map((hit) => el('li', {}, el('code', { text: hit.module }))),
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
              `${downloadPrefix}.yml.txt`,
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

  controls.projectName = bind(textInput('platform', 'Used in file headers'));
  controls.datacenter = bind(textInput('dc-01', 'vSphere datacenter'));
  controls.outputDir = bind(textInput('./collected', 'Where collected JSON is written'));
  controls.validateCerts = bind(select(VALIDATE_CERTS, 'default'));
  const legacyBox = checkbox('Also install community.vmware (legacy)', false);
  controls.legacyVmware = bind(legacyBox.input);
  controls.clusters = bind(
    textInput('mgmt-01:yes:yes:Fully Automated', 'name:ha:drs:level, comma separated'),
  );
  controls.moduleQuery = bind(textInput('', 'Search every module, e.g. "cluster" or "s3 bucket"'));

  const targetBoxes = TARGETS.map((target) => {
    const box = checkbox(target.label, target.value === 'vmware');
    controls.targets[target.value] = bind(box.input);
    return el('div', { class: 'field' }, box.wrap);
  });

  const collectionNotes = COLLECTIONS.filter((c) => !c.builtin).map((c) =>
    el(
      'div',
      { class: 'section-note', style: { marginTop: 'var(--space-2)' } },
      el('strong', { text: c.name }),
      el('span', { class: 'muted', text: ` ${c.observedVersion} — ${c.credentials}` }),
    ),
  );

  return el(
    'div',
    { class: 'stack' },
    card('Platforms', ...targetBoxes, el('div', { class: 'field' }, legacyBox.wrap)),
    card('Project', field('Name', controls.projectName)),
    card(
      'vSphere',
      field('Datacenter', controls.datacenter, 'vSphere has no global scope; every task names one.'),
      field('Collection output', controls.outputDir),
      field('Certificates', controls.validateCerts),
      field(
        'Clusters',
        controls.clusters,
        'name:ha:drs:level. Leave a field blank to say nothing about it — a blank is not a "no".',
      ),
    ),
    card('Module catalog', field('Search', controls.moduleQuery, 'Names come from Ansible Galaxy.')),
    card('Where credentials come from', ...collectionNotes),
  );
}

const root = document.getElementById('ansible-root');
if (root) mountAnsiblePage(root);

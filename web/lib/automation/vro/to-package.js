/**
 * An automation as one Orchestrator package.
 *
 * A blueprint describes its automation once — the main workflow, the actions
 * it calls, the settings, the payloads — and this writes the text files of two
 * packages beside each other in the output:
 *
 *   import/vcf.automation.core.package/…     the shared core library
 *   import/<packageName>.package/…            this automation
 *
 * The page's "Download as .zip" builds and signs each folder into a real
 * .package (src/kit/archive.ts, src/kit/vro-package.ts). The layout under a
 * package folder is the one readPackageSpec reads:
 *
 *   package.json
 *   workflows/<categoryPath>/<workflow name>.xml
 *   actions/<packageName>/<action>.js  +  .json
 *   config/<categoryPath>/<config name>.json
 *   resources/<categoryPath>/<file>    +  resources.json
 *
 * The workflow is the central component: one scriptable task, whose script
 * this prefixes with the lines every automation starts with —
 *
 *   var core = System.getModule("vcf.automation.core");
 *   var mod = System.getModule("<packageName>");
 *   var SETTINGS_PATH = "<categoryPath>", SETTINGS_NAME = "<config name>";
 *   var RESOURCE_PATH = "<categoryPath>";
 *   var settings = core.settings(SETTINGS_PATH, SETTINGS_NAME);
 *
 * (mod only when the package has actions) — so the blueprint's script has core,
 * mod, settings and RESOURCE_PATH in
 * scope and reads a payload with core.resource(RESOURCE_PATH, "<file>").
 *
 * Every id is stable (derived from names), so importing a regenerated package
 * updates the elements in place instead of adding copies.
 */

import { stableId, workflowId, workflowXml,                                         } from '../vcfa-import.js';
                                                                   
import { CORE_PACKAGE_DIR, CORE_REF, actionFiles, corePackageFiles,                   } from './core.js';

                                        
                                                                                                           
                               
                               
                                                                                                     
                            
                                                                                                       
                                
                      
                          
                                 
                                         
                                          
                                                                                                 
                            
    
                                                               
                                             
                    
                          
                                 
                                                       
    
                                                                                   
                                                                                                                  
 

                                    
                                                                               
                                         
                                     
                              
                               
                           
                                
                              
                                
                              
                                                                
                                      
                                                              
                                                                                                   
 

const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** A package name from free text: vcf.automation.<parts>, each part lower case letters, digits and underscores. */
export function packageNameOf(...parts                   )         {
  const clean = parts
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .map((part) => (/^[0-9]/.test(part) ? `n${part}` : part));
  return ['vcf', 'automation', ...clean].join('.');
}

/** The lines the workflow script starts with. */
export function prologue(spec                                                                                    )         {
  const q = JSON.stringify;
  return [
    CORE_REF,
    ...((spec.actions ?? []).length > 0 ? [`var mod = System.getModule(${q(spec.packageName)});`] : []),
    `var SETTINGS_PATH = ${q(spec.categoryPath)};`,
    `var SETTINGS_NAME = ${q(spec.config.name)};`,
    `var RESOURCE_PATH = ${q(spec.categoryPath)};`,
    'var settings = core.settings(SETTINGS_PATH, SETTINGS_NAME);',
    '',
  ].join('\n');
}

export function toPackage(spec                       )                    {
  if (!NAME.test(spec.packageName)) throw new Error(`${spec.packageName}: a package name is lower-case dotted words, e.g. vcf.automation.tags.compliance`);
  for (const [what, value] of [['workflow', spec.workflow.name], ['configuration element', spec.config.name], ...(spec.resources ?? []).map((r) => ['resource', r.name])]         ) {
    if (!value || value.includes('/')) throw new Error(`The ${what} name "${value}" is empty or has a "/"; the folder is categoryPath.`);
  }
  const version = spec.version ?? '1.0.0';
  const dir = `import/${spec.packageName}.package`;
  const category = spec.categoryPath.split('/').filter(Boolean).join('/');
  const inner                         = {
    'package.json': `${JSON.stringify({ name: spec.packageName, description: spec.description, version }, null, 2)}\n`,
  };

  const workflow                      = {
    name: spec.workflow.name,
    category,
    description: spec.workflow.description,
    inputs: spec.workflow.inputs,
    outputs: spec.workflow.outputs,
    script: `${prologue({ ...spec, categoryPath: category })}${spec.workflow.script}`,
    taskName: spec.workflow.name,
  };
  inner[`workflows/${category}/${spec.workflow.name}.xml`] = workflowXml(workflow);

  for (const action of spec.actions ?? []) Object.assign(inner, actionFiles(spec.packageName, action));

  inner[`config/${category}/${spec.config.name}.json`] = `${JSON.stringify(
    { id: stableId(`vro-config:${category}/${spec.config.name}`), description: spec.config.description, attributes: spec.config.attributes },
    null,
    2,
  )}\n`;

  const resourceMeta                                                   = {};
  for (const r of spec.resources ?? []) {
    inner[`resources/${category}/${r.name}`] = r.content;
    resourceMeta[`${category}/${r.name}`] = { id: stableId(`vro-resource:${category}/${r.name}`), mimeType: r.mimeType ?? (r.name.endsWith('.json') ? 'application/json' : 'text/plain') };
  }
  if (Object.keys(resourceMeta).length > 0) inner['resources.json'] = `${JSON.stringify(resourceMeta, null, 2)}\n`;

  const files                         = { ...corePackageFiles() };
  for (const [path, body] of Object.entries(inner)) files[`${dir}/${path}`] = body;

  const secrets = spec.config.attributes.filter((a) => a.type === 'SecureString').map((a) => a.name);
  const urlSecrets = secrets.filter((name) => /webhook|url$|endpoint/i.test(name));
  const id = workflowId(workflow);
  const hasDryRun = spec.workflow.inputs.some((input) => input.name === 'dryRun');
  const contents = Object.keys(files).filter((path) => path.startsWith(`${dir}/`) || path.startsWith(`${CORE_PACKAGE_DIR}/`));

  const importSteps = [
    {
      heading: 'Import the two Orchestrator packages',
      lines: [
        `The download holds \`${CORE_PACKAGE_DIR}\` (the shared vcf.automation core library) and \`${dir}\` (this automation), each built and signed as a .package when you download the .zip. Import the core library first; it is the same in every vcf.automation package, so after the first time importing it again only updates it.`,
        '',
        'VCF 9.1: in VCF Automation, the **Orchestrate** tab (All Apps organization) or the **Orchestrator** tab (VM Apps organization); VCF Operations orchestrator standalone: its own client. Then **Assets → Packages → Import**, choose the .package, and trust the publisher certificate when asked — it is a certificate made for this download, so check it is the one you expect. Element ids are stable, so a regenerated package updates the same workflow, actions and settings rather than adding copies; each element carries the package version, so when re-importing over an older import either raise the version or accept the import dialog\'s offer to replace elements of the same version (VERIFY the dialog wording on your release).',
        '',
        `Orchestrator lists them as ${CORE_PACKAGE_DIR.slice('import/'.length, -'.package'.length)}-1.0.0 and ${spec.packageName}-${version}. The package holds: the workflow **${spec.workflow.name}** (id ${id}) in ${category}; ${(spec.actions ?? []).length} action(s) in module ${spec.packageName}; the configuration element **${spec.config.name}** in ${category}${(spec.resources ?? []).length > 0 ? `; resource elements ${(spec.resources ?? []).map((r) => r.name).join(', ')} in ${category}` : ''}.`,
        '',
        'Files, as reviewable text before they are built:',
        '',
        ...contents.map((path) => `- \`${path}\``),
      ],
    },
    {
      heading: 'Trust the endpoint certificates',
      lines: [
        'Every call goes through a transient REST host, which accepts only certificates Orchestrator trusts. For each host in the configuration element, run the workflow **Library → Configuration → SSL Trust Manager → Import a certificate from URL** with https://<host>. A missing certificate fails the first call with an SSL handshake error; nothing is ever sent unverified.',
      ],
    },
    {
      heading: 'Fill the settings',
      lines: [
        `Assets → Configurations → ${category} → **${spec.config.name}**. Set the hosts and accounts${secrets.length > 0 ? `, and type the secrets into ${secrets.map((s) => `**${s}**`).join(', ')} (SecureString: empty in the package, stored encrypted by Orchestrator, never logged by the workflow)` : ''}.`,
        ...(urlSecrets.length > 0
          ? [
              '',
              `${urlSecrets.map((s) => `**${s}**`).join(', ')} ${urlSecrets.length > 1 ? 'are URLs, kept as SecureStrings' : 'is a URL, kept as a SecureString'}: a Slack, Teams or Google Chat webhook carries its secret in the path, so the URL is the credential. It is empty after import; type the URL you mean to use (left empty, nothing is posted), and the workflow logs only its host.`,
            ]
          : []),
        ...(hasDryRun ? ['', 'dryRun in the configuration element is off: the workflow makes its changes when run. Set it (or the workflow input dryRun) to true to preview instead. cap is the most changes one run may make.'] : []),
      ],
    },
    {
      heading: 'Run it and read the log',
      lines: [
        hasDryRun
          ? `Run **${spec.workflow.name}**. The log lists every change and ends with an AUDIT summary. To preview first, run it with the dryRun input set to true: it logs "DRY RUN: would …" and changes nothing.`
          : `Run **${spec.workflow.name}**. It only reads; the log ends with an AUDIT summary and the outputs hold the result.`,
      ],
    },
    {
      heading: 'Then use it',
      lines: [
        '- **On a schedule:** select the workflow in the Library and click **Schedule** (listed under Activity → Scheduled). VCF 9.1: Orchestrate tab → Library → the workflow → Schedule.',
        '- **From the catalog:** add a content source of type Automation Orchestrator (VCF Automation 9.1: the organization\'s catalog content sources — VERIFY the menu on your release) that includes this workflow, and share it with the projects that should see it.',
        '- **From a VCF Automation event:** Extensibility → Subscriptions → New, runnable type Workflow, this workflow.',
        `- **From a VCF Operations alert (9.1):** Operate → Administration → Configurations → Outbound Settings → Add a Webhook Notification Plugin with URL https://<VCF Automation FQDN>/vro/runs/ and a bearer token of a service account; Payload Template → Add, application/json, POST, a body with "workflowId": "${id}" and its parameters; Notifications → Add a rule with that outbound method and template, scoped to the alert (techtested.org, "How to trigger a VCF Operations Orchestrator Workflow from VCF Operations 9.1").`,
      ],
    },
  ];

  return { files, packageDir: dir, packageName: spec.packageName, version, workflowName: spec.workflow.name, workflowId: id, categoryPath: category, configName: spec.config.name, secrets, importSteps };
}

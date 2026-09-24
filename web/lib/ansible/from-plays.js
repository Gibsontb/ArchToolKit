/**
 * Turn a play structure into the files someone can actually run.
 *
 * The ported blueprints return plays as plain objects — the shape the YAML
 * already has, with module names as keys. Rendering those directly keeps the
 * originals untouched, and everything useful can still be read back out of the
 * structure rather than being declared twice:
 *
 *  - `requirements.yml` is derived from the modules the play actually uses, so
 *    it cannot drift from the play. Since ansible-core 2.10 a playbook that
 *    names a module without requiring its collection fails at run time with a
 *    message that just says the module does not exist.
 *  - Every module name is checked against the committed Galaxy catalog, so a
 *    misremembered one is caught here rather than there.
 */

import { error, info, warning,              } from '../core/findings.js';
import { renderYaml,                } from './yaml.js';
import { catalogueFor, classifyModule } from './catalog.js';
import { collectionFor, collectionOfModule, installable } from './collections.js';

/** namespace.collection.module — three dot-separated segments, lowercase. */
const FQCN = /^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/;

/**
 * Every fully qualified module name anywhere in a play structure.
 *
 * Walks keys rather than a task list, because a module can appear inside a
 * block, a rescue, a handler or a nested loop, and a walker does not need to
 * know which.
 */
export function collectModules(value         )                    {
  const found = new Set        ();
  const walk = (node         )       => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node                           )) {
      if (FQCN.test(key)) found.add(key);
      walk(child);
    }
  };
  walk(value);
  return [...found].sort();
}

                                
                                                   
                                        
 

function requirementsYml(collections                   )                {
  const infos = installable(collections);
  if (infos.length === 0) return null;

  /*
   * A collection whose version this build never read from Galaxy takes its
   * constraint from the committed module catalog when that holds one, and is
   * otherwise left unpinned. An invented pin is worse than none: to a release
   * that does not exist it fails the install, and to the wrong major line it
   * installs modules that have since been renamed.
   */
  const unpinned           = [];
  const entries = infos.map((c) => {
    if (c.pinned !== false) return { name: c.name, version: c.version };
    const catalogued = catalogueFor(c.name);
    if (catalogued) {
      const major = catalogued.version.split('.')[0] ?? '0';
      return { name: c.name, version: `>=${catalogued.version},<${Number(major) + 1}.0.0` };
    }
    unpinned.push(c.name);
    return { name: c.name };
  });

  const header = [
    'Collections this playbook needs.',
    '',
    'Install with:  ansible-galaxy collection install -r requirements.yml',
    '',
    'Derived from the modules the playbook actually uses, and pinned to the',
    'major line Galaxy reported when this toolkit was built.',
  ];
  if (unpinned.length > 0) {
    header.push(
      '',
      `Unpinned here, because this build had no Galaxy version for them: ${unpinned.join(', ')}.`,
      'Run npm run ansible:update on a machine with network access to pin them,',
      'or write the version your estate is standardised on.',
    );
  }

  return renderYaml({ collections: entries }, { header: header.join('\n') });
}

export function playbookFiles(
  plays           ,
  name        ,
  label        ,
)                {
  const findings            = [];
  const modules = collectModules(plays);
  const collections = new Set        ();

  for (const module of modules) {
    const collection = collectionOfModule(module);
    if (collection) collections.add(collection);

    switch (classifyModule(module)) {
      case 'module':
        break;
      case 'unknown': {
        const info_ = collection ? collectionFor(collection) : undefined;
        findings.push(
          error(
            'ansible.blueprint.unknown-module',
            `"${module}" is not a module in ${collection}${info_ ? ` ${info_.observedVersion}` : ''}.`,
            {
              remediation:
                'Check the name against the catalog, or run npm run ansible:update if the collection is newer than the catalog.',
              source: 'Ansible Galaxy catalog',
            },
          ),
        );
        break;
      }
      case 'uncatalogued':
        findings.push(
          warning(
            'ansible.blueprint.uncatalogued-collection',
            `${collection} is not in the catalog, so "${module}" could not be checked.`,
            { remediation: 'Run npm run ansible:update.', source: 'ArchToolKit' },
          ),
        );
        break;
      default:
        break;
    }
  }

  const files                         = {};
  const filename = `${name || 'playbook'}.yml`;

  files[filename] = renderYaml(plays, {
    header: [
      `${label}`,
      '',
      `Run with:  ansible-playbook -i inventory ${filename} --check --diff`,
      '',
      'Credentials belong in the environment or an ansible-vault file, never in',
      'this playbook. Nothing here writes one.',
    ].join('\n'),
  });

  const requirements = requirementsYml([...collections].sort());
  if (requirements) files['requirements.yml'] = requirements;

  findings.push(
    info(
      'ansible.blueprint.modules-used',
      modules.length === 0
        ? 'No fully qualified module names were found in this playbook.'
        : `Uses ${modules.length} module(s) across ${collections.size} collection(s).`,
      { source: 'ArchToolKit' },
    ),
  );

  findings.push(
    info(
      'ansible.blueprint.arguments-not-validated',
      'Module arguments are rendered as written. The catalog knows which modules exist, not what each one accepts, so run ansible-playbook --check --diff before relying on this.',
      { source: 'ArchToolKit' },
    ),
  );

  return { files, findings };
}

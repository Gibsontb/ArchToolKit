/**
 * Emit tasks and plays for any collection in the kit.
 *
 * The hand-written content covers the cases worth getting exactly right; this
 * covers the rest. Give it a module and a set of arguments and it renders valid
 * YAML, checking the module against the catalog first so a misremembered name is
 * caught here rather than at run time — where Ansible's only complaint is that
 * the module could not be found, with no hint that it was a typo.
 *
 * It deliberately does not validate arguments. The catalog knows which modules
 * exist, not what each one takes, and inventing that would be the same mistake
 * as generating modules from memory. What it can do is be honest: the module is
 * checked, the values are rendered faithfully, and anything it cannot vouch for
 * is said plainly.
 *
 * Two things it does refuse to be quiet about:
 *
 *  - A literal-looking credential. A password written into a playbook is in
 *    version control a moment later, and the fix — a vault variable — costs
 *    nothing at authoring time and a great deal afterwards.
 *  - A short module name. `copy` resolves through the collections search path,
 *    which differs between control nodes, so a playbook that runs on one can
 *    fail on another for reasons that look like nothing at all.
 */

import { error, info, warning,              } from '../core/findings.js';
import { renderYaml,                } from './yaml.js';
import { classifyModule } from './catalog.js';
import { collectionOfModule, collectionFor, installable } from './collections.js';

/** A module argument as a caller supplies it. */
                                     

                                
                                                    
 

                               
                        
                                                                     
                          
                                     
                                             
                                                
                             
                                    
                            
                               
                             
                                  
                                                                          
                           
                                      
                                                                
                                 
 

                       
                        
                                                                          
                         
     
                                                                               
                                                                            
     
                                 
                            
                                
                                         
                                          
                                              
                                     
                                    
                                                                                   
                               
 

/**
 * Argument names whose value ought never be a literal.
 *
 * Matched on the name rather than the value, because the point is to catch the
 * credential before someone types a real one into it.
 */
const SECRET_ARGUMENTS =
  /(^|_)(password|passwd|secret|token|api_key|apikey|private_key|client_secret|auth_key)($|_)/i;

/** A value that defers to a variable, a lookup or a vault rather than stating a secret. */
function isIndirect(value           )          {
  return typeof value === 'string' && /\{\{.*\}\}/.test(value);
}

function collectSecretFindings(task              , index        )            {
  const findings            = [];
  const args = task.arguments ?? {};
  let sensitive = false;

  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (!SECRET_ARGUMENTS.test(name)) continue;
    sensitive = true;
    if (typeof value === 'string' && value !== '' && !isIndirect(value)) {
      findings.push(
        error(
          'ansible.task.literal-credential',
          `Task "${task.name}" sets ${name} to a literal value, which puts a credential in the playbook.`,
          {
            path: `tasks[${index}].${name}`,
            remediation:
              'Reference a variable instead — {{ vault_xxx }} from an ansible-vault file, or an environment lookup.',
            source: 'ArchToolKit',
          },
        ),
      );
    }
  }

  if (sensitive && task.noLog !== true) {
    findings.push(
      warning(
        'ansible.task.secret-logged',
        `Task "${task.name}" handles a credential but does not set no_log, so the value can appear in output and in the log.`,
        { path: `tasks[${index}].no_log`, remediation: 'Set no_log: true on this task.' },
      ),
    );
  }

  return findings;
}

function moduleFindings(task              , index        )            {
  const kind = classifyModule(task.module);
  const path = `tasks[${index}].${task.module}`;

  switch (kind) {
    case 'module':
      return [];
    case 'unknown': {
      const collection = collectionOfModule(task.module);
      const info_ = collection ? collectionFor(collection) : undefined;
      return [
        error(
          'ansible.task.unknown-module',
          `"${task.module}" is not a module in ${collection}${info_ ? ` ${info_.observedVersion}` : ''}.`,
          {
            path,
            remediation:
              'Check the name against the catalog, or run npm run ansible:update if the collection is newer than the catalog.',
            source: 'Ansible Galaxy catalog',
          },
        ),
      ];
    }
    case 'uncatalogued':
      return [
        warning(
          'ansible.task.uncatalogued-collection',
          `${collectionOfModule(task.module)} is not in the catalog, so "${task.module}" could not be checked.`,
          { path, remediation: 'Run npm run ansible:update.', source: 'ArchToolKit' },
        ),
      ];
    case 'not-qualified':
      return [
        warning(
          'ansible.task.short-module-name',
          `"${task.module}" is not fully qualified, so which module runs depends on the control node's collections path.`,
          {
            path,
            remediation:
              'Use the full namespace.collection.module name, e.g. ansible.builtin.copy rather than copy.',
            source: 'Ansible collections documentation',
          },
        ),
      ];
    default:
      return [];
  }
}

/** One task as the mapping Ansible expects, with the module key in the middle. */
export function taskToYaml(task              )                            {
  const out                            = { name: task.name };

  // Ansible takes the module's arguments as the value of a key named after the
  // module. An empty mapping is correct for modules that take nothing.
  out[task.module] = (task.arguments ?? {})             ;

  if (task.register !== undefined) out.register = task.register;
  if (task.loop !== undefined) out.loop = task.loop             ;
  if (task.when !== undefined) out.when = task.when             ;
  if (task.become !== undefined) out.become = task.become;
  if (task.delegateTo !== undefined) out.delegate_to = task.delegateTo;
  if (task.runOnce !== undefined) out.run_once = task.runOnce;
  if (task.ignoreErrors !== undefined) out.ignore_errors = task.ignoreErrors;
  if (task.noLog !== undefined) out.no_log = task.noLog;
  if (task.notify !== undefined) out.notify = task.notify             ;
  if (task.tags !== undefined) out.tags = task.tags             ;

  for (const [key, value] of Object.entries(task.extra ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function playToYaml(play      )                            {
  const out                            = { name: play.name, hosts: play.hosts };
  if (play.connection !== undefined) out.connection = play.connection;
  if (play.gatherFacts !== undefined) out.gather_facts = play.gatherFacts;
  if (play.become !== undefined) out.become = play.become;
  if (play.serial !== undefined) out.serial = play.serial;
  if (play.varsFiles !== undefined) out.vars_files = play.varsFiles             ;
  if (play.vars !== undefined) out.vars = play.vars             ;
  if (play.roles !== undefined) out.roles = play.roles             ;
  out.tasks = play.tasks.map(taskToYaml);
  if (play.handlers !== undefined && play.handlers.length > 0) {
    out.handlers = play.handlers.map(taskToYaml);
  }
  return out;
}

                                 
                        
                                        
                                                                  
                                          
 

                                  
                           
 

/** Collections every task in these plays draws on, built-ins excluded. */
export function requiredCollections(plays                 )                    {
  const names = new Set        ();
  for (const play of plays) {
    for (const task of [...play.tasks, ...(play.handlers ?? [])]) {
      const collection = collectionOfModule(task.module);
      if (collection) names.add(collection);
    }
  }
  return installable([...names].sort()).map((c) => c.name);
}

export function emitPlaybook(
  plays                 ,
  options                  = {},
)                 {
  const findings            = [];

  if (plays.length === 0) {
    return {
      yaml: renderYaml([], options),
      findings: [
        warning('ansible.playbook.empty', 'No plays were given, so an empty playbook was written.'),
      ],
      collections: [],
    };
  }

  for (const play of plays) {
    if (play.tasks.length === 0) {
      findings.push(
        warning('ansible.play.no-tasks', `Play "${play.name}" has no tasks.`, {
          path: `plays.${play.name}`,
        }),
      );
    }

    play.tasks.forEach((task, index) => {
      findings.push(...moduleFindings(task, index));
      findings.push(...collectSecretFindings(task, index));
    });
    (play.handlers ?? []).forEach((task, index) => {
      findings.push(...moduleFindings(task, index));
    });

    // Gathering facts against localhost for an API-only play is a connection and
    // a few seconds per run that buys nothing, and it is the usual reason a
    // cloud playbook is slower than the API calls it makes.
    if (play.hosts === 'localhost' && play.gatherFacts === undefined) {
      findings.push(
        info(
          'ansible.play.gather-facts-default',
          `Play "${play.name}" runs against localhost and will gather facts, which an API-only play does not need.`,
          { remediation: 'Set gather_facts: false.', source: 'ArchToolKit' },
        ),
      );
    }
  }

  findings.push(
    info(
      'ansible.playbook.arguments-not-validated',
      'Module arguments are rendered as given. The catalog knows which modules exist, not what each one accepts, so run ansible-playbook --check --diff before relying on this.',
      { source: 'ArchToolKit' },
    ),
  );

  return {
    yaml: renderYaml(plays.map(playToYaml), options),
    findings,
    collections: requiredCollections(plays),
  };
}

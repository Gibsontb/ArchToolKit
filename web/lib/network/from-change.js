/**
 * A change, as the files someone can use.
 *
 * Three of them, because a network change is three jobs: the configuration to
 * paste or diff, the playbook that applies the same thing to many devices, and
 * the record that goes in the ticket. They are generated from one structure so
 * they cannot drift apart, and the playbook's module names are checked against
 * the committed Galaxy catalog exactly as the Ansible kit's are.
 *
 * This is also where a blueprint is declared, so that the page and the change
 * list both reach the same builder: `deviceBlueprint` keeps the structured
 * builder beside the `Blueprint` the page renders, rather than the change list
 * having to parse configuration text back out of a file.
 */

                                                                                   
import { slug } from '../kit/blueprint.js';
import { info,              } from '../core/findings.js';
import { playbookFiles } from '../ansible/from-plays.js';
import { PLATFORMS, renderChange, renderRecord, standingFindings,                                  } from './device.js';
import { playFor } from './push.js';

                                                    
                                                                            
                              
                                                                
                                                                           
 

/**
 * The same blueprint, with the Ansible module that applies it attached.
 *
 * Some changes are written as CLI because that is how they are usually made,
 * but a real module exists for them. Rather than restate the whole change
 * inside the blueprint literal, the module is attached here, beside the list,
 * where it can be read against the collection's documentation in one place.
 */
export function withPush(blueprint                 , push                                                                 )                  {
  const change = (values                 , name        )               => ({ ...blueprint.change(values, name), push: push(values, name) });
  return { ...blueprint, change, build: (values, name) => changeFiles(change(values, name), name) };
}

export function changeFiles(change              , name        )              {
  const platform = PLATFORMS[change.platform];
  const base = slug(name, 'change').replace(/_/g, '-');
  const files                         = {};
  const findings            = [...(change.findings ?? []), ...standingFindings(change)];

  files[`${base}${platform.extension}`] = renderChange(change, name);

  const play = playFor(change, name);
  if (!play) {
    findings.push(
      info('network.change.cli-only', 'No Ansible module covers this change, so no playbook is generated. Apply it from the CLI or the API, and keep the record with it.', {
        source: 'ArchToolKit',
      }),
    );
  }
  if (play) {
    const playbook = playbookFiles(play, base, `${change.title} (${platform.label})`);
    for (const [file, contents] of Object.entries(playbook.files)) files[file] = contents;
    // The "uses N modules" line is noise on a single change; the warnings are not.
    findings.push(...playbook.findings.filter((f) => f.code !== 'ansible.blueprint.modules-used'));
  }

  files['change-record.md'] = `${[`# ${name || change.title}`, '', ...renderRecord(change, name)].join('\n')}\n`;

  return { files, findings };
}

/**
 * Declare a blueprint from a change builder.
 *
 * The page sees an ordinary `Blueprint`; the change list sees the structured
 * builder underneath it. Writing both by hand is how the two would eventually
 * disagree about what a blueprint emits.
 */
export function deviceBlueprint(
  spec                                        
                                
                                       
                                                                             
   ,
)                  {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values                 , name        ) => changeFiles(spec.change(values, name), name),
  };
}

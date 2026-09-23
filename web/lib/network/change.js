/**
 * Several changes as one change.
 *
 * A network change is rarely one command. Standing up a rack is a VLAN, an
 * SVI, a trunk, a port-channel and a firewall rule; cutting an application
 * over is a VIP, a NAT and a policy. Done one blueprint at a time you get five
 * files and no order, and the order is the part that matters: build the VLAN
 * before the trunk that carries it, the pool before the virtual server,
 * the interface before the rule that references its zone.
 *
 * So the build list assembles them: the configuration in order, one file per
 * step, a single playbook that applies them in that order, and one change
 * record with every pre-check, every verification and — reversed — every
 * back-out. Reversed, because undoing a change means undoing its steps in the
 * opposite order to the one that built them.
 *
 * What it refuses to do is merge two platforms into one file. A change that
 * touches a switch and a firewall is two files, because it is two sessions on
 * two devices.
 */

                                                                      
import { defaultValues } from '../kit/blueprint.js';
import { numbered, slug,                                                      } from '../kit/stack.js';
import { error, info, warning,              } from '../core/findings.js';
import { renderYaml } from '../ansible/yaml.js';
import { playbookFiles } from '../ansible/from-plays.js';
import { changeFileName, IMPACT_MEANING, PLATFORMS, renderChange, renderRecord,                                               } from './device.js';
import { inventoryHint, NETWORK_ANSIBLE_CFG, networkInventory, playFor } from './push.js';
import { networkChange } from './blueprints/index.js';
import { fullConfig } from './full-config.js';

                                
                                                                     
                           
                                                                           
                              
 

const IMPACT_ORDER                                   = { none: 0, brief: 1, outage: 2 };

/** The worst impact in the list, which is the impact of the change as a whole. */
function overallImpact(changes                         )         {
  let worst         = 'none';
  for (const change of changes) if (IMPACT_ORDER[change.impact] > IMPACT_ORDER[worst]) worst = change.impact;
  return worst;
}

                
                           
                        
                        
                                
 

/**
 * Assemble the build list into one change.
 *
 * Every item is rebuilt from its blueprint rather than from whatever it
 * produced when it was added, so an item added an hour ago reflects the rules
 * as they are now.
 */
export function buildChange(items                      , blueprintFor                                       , options                = {})             {
  const findings            = [];
  const name = slug(options.stackName ?? '', 'network-change');
  void name;

  if (items.length === 0) {
    return {
      files: {},
      findings: [info('network.change.empty', 'Nothing in the change yet. Add the pieces one at a time and they are assembled in order.', { source: 'ArchToolKit' })],
      references: [],
    };
  }

  const steps         = [];
  const used = new Set        ();

  items.forEach((item, index) => {
    const blueprint = blueprintFor(item.blueprintId);
    const structured = networkChange(item.blueprintId);
    if (!blueprint || !structured) {
      findings.push(
        error('network.change.blueprint-gone', `"${item.label}" is built from ${item.blueprintId}, which this page does not have.`, {
          remediation: 'It may belong to another platform. Switch the platform back, or remove the item.',
          source: 'ArchToolKit',
        }),
      );
      return;
    }

    const label = slug(item.label, `step-${index + 1}`);
    const unique = used.has(label) ? `${label}-${index + 1}` : label;
    if (used.has(label)) {
      findings.push(
        warning('network.change.duplicate-name', `Two steps are called "${item.label}". The second was written as ${unique}.`, {
          remediation: 'Give them different names so the files and the record read clearly.',
          source: 'ArchToolKit',
        }),
      );
    }
    used.add(unique);

    const values                  = { ...defaultValues(blueprint), ...item.values };
    let change              ;
    try {
      change = structured.change(values, item.label);
    } catch (err) {
      findings.push(error('network.change.build-failed', `"${item.label}" could not be built: ${(err         ).message}`, { source: 'ArchToolKit' }));
      return;
    }

    findings.push(...(change.findings ?? []));
    steps.push({ item, name: unique, file: numbered(steps.length, unique, ''), change });
  });

  if (steps.length === 0) {
    return { files: {}, findings, references: [] };
  }

  const platforms = [...new Set(steps.map((s) => s.change.platform))];
  const files                         = {};

  // One configuration file per step, in order, in the device's own syntax.
  for (const step of steps) {
    files[changeFileName(step.change, step.file)] = renderChange(step.change, step.item.label);
  }

  /*
   * One complete configuration per platform.
   *
   * Not the steps stacked: merged. Two steps that both touch Gi1/0/1 become
   * one interface block with everything they set, and the whole thing comes out
   * in the order the platform's own running configuration uses. That is what
   * you want when you are building a device rather than changing one — and for
   * F5 it is the only correct answer, because AS3 replaces a tenant wholesale
   * and two declarations for one tenant would delete each other.
   */
  for (const platform of platforms) {
    const mine = steps.filter((s) => s.change.platform === platform);
    if (mine.length < 2) continue;
    const info_ = PLATFORMS[platform];
    const whole = fullConfig(
      platform,
      mine.map((step) => ({ label: step.item.label, change: step.change })),
      options.stackName ?? 'network build',
    );
    if (whole.text.trim() === '') continue;
    files[`full-${platform.replace(/_/g, '-')}${info_.extension}`] = whole.text;
    findings.push(...whole.findings);
  }

  // One playbook that applies the steps in order, and the collections it needs.
  const plays            = [];
  for (const step of steps) {
    const play = playFor(step.change, step.item.label, changeFileName(step.change, step.file));
    if (Array.isArray(play)) plays.push(...play);
  }
  if (plays.length > 0) {
    files['apply.yml'] = renderYaml(plays         , {
      header: [
        `${options.stackName ?? 'Network change'} — every step, in order.`,
        '',
        'Dry run first:  ansible-playbook -i inventory apply.yml --check --diff',
        'Then apply:     ansible-playbook -i inventory apply.yml --diff --limit <device>',
        '',
        'The steps run in the order they were added. Stop at the first failure —',
        'the back-out in change-record.md undoes them in the opposite order.',
      ].join('\n'),
    });

    // The collections the playbook needs, and a check of every module name in
    // it against the committed Galaxy catalog — the same check the Ansible kit
    // makes, rather than a second opinion.
    const checked = playbookFiles(plays         , 'apply', options.stackName ?? 'Network change');
    const requirements = checked.files['requirements.yml'];
    if (requirements) files['requirements.yml'] = requirements;
    findings.push(...checked.findings.filter((f) => f.code !== 'ansible.blueprint.modules-used'));
  }

  // The inventory the playbook expects, with the connection variables per platform.
  files['inventory/hosts.yml'] = networkInventory(platforms);
  if (files['apply.yml']) files['ansible.cfg'] = NETWORK_ANSIBLE_CFG;

  // The record: what is being done, in order, with the back-out reversed.
  files['change-record.md'] = changeRecord(steps, options.stackName ?? 'Network change', platforms);

  files['README.md'] = readme(steps, options.stackName ?? 'Network change', platforms);

  const impact = overallImpact(steps.map((s) => s.change));
  findings.push(
    impact === 'none'
      ? info('network.change.impact', IMPACT_MEANING.none, { source: 'ArchToolKit' })
      : warning('network.change.impact', `${steps.length} step(s), worst impact: ${IMPACT_MEANING[impact]}`, {
          remediation: 'The record lists the pre-checks, the verification and the back-out in the order to use them.',
          source: 'ArchToolKit',
        }),
  );
  if (platforms.length > 1) {
    findings.push(
      info('network.change.multi-platform', `This change touches ${platforms.length} platforms: ${platforms.map((p) => PLATFORMS[p].label).join(', ')}. Each one gets its own file.`, {
        source: 'ArchToolKit',
      }),
    );
  }

  return { files, findings, references: references(steps) };
}

/** What a later step can refer to: the names the earlier steps created. */
function references(steps                 )                   {
  const out                   = [];
  for (const step of steps) {
    out.push({ expression: step.name, item: step.item.label, address: `${step.file} (${PLATFORMS[step.change.platform].label})`, attribute: 'name' });
  }
  return out;
}

function changeRecord(steps                 , title        , platforms                     )         {
  const impact = overallImpact(steps.map((s) => s.change));
  const lines           = [
    `# ${title}`,
    '',
    `**Devices:** ${platforms.map((p) => PLATFORMS[p].label).join(', ')}  `,
    `**Steps:** ${steps.length}  `,
    `**Impact:** ${IMPACT_MEANING[impact]}`,
    '',
    'Generated by ArchToolKit. Every line is a draft for review: check it against the running configuration before it is applied.',
    '',
    '## Before the window',
    '',
    'Capture the current state, so there is something to compare against and to restore from.',
    '',
    '```',
    ...[...new Set(steps.flatMap((s) => s.change.before))],
    '```',
    '',
    '## The steps, in order',
    '',
  ];

  steps.forEach((step, index) => {
    lines.push(
      `${index + 1}. **${step.item.label}** — ${step.change.title} (${PLATFORMS[step.change.platform].label}). Impact: ${step.change.impact}. File: \`${step.file}${PLATFORMS[step.change.platform].extension}\`.`,
    );
  });
  lines.push('');

  for (const step of steps) {
    lines.push(...renderRecord(step.change, step.item.label));
  }

  lines.push(
    '## Back-out, in reverse order',
    '',
    'Undo the steps in the opposite order to the one that applied them: the last thing built is the first thing removed.',
    '',
    '```',
    ...[...steps].reverse().flatMap((step) => [`${PLATFORMS[step.change.platform].comment} ${step.item.label}`, ...step.change.backout, '']),
    '```',
    '',
    '## Sign-off',
    '',
    '| | Name | Date |',
    '| --- | --- | --- |',
    '| Prepared by | | |',
    '| Reviewed by | | |',
    '| Approved by | | |',
    '',
  );

  return `${lines.join('\n')}\n`;
}

function readme(steps                 , title        , platforms                     )         {
  const lines = [
    `# ${title}`,
    '',
    `${steps.length} step(s) across ${platforms.length} platform(s), generated by ArchToolKit.`,
    '',
    '## What is here',
    '',
    '| File | What it is |',
    '| --- | --- |',
    ...steps.map((step) => `| \`${step.file}${PLATFORMS[step.change.platform].extension}\` | ${step.change.title} |`),
    ...platforms
      .filter((platform) => steps.filter((s) => s.change.platform === platform).length > 1)
      .map(
        (platform) =>
          `| \`full-${platform.replace(/_/g, '-')}${PLATFORMS[platform].extension}\` | The complete ${PLATFORMS[platform].label} configuration: every step merged, in the order the platform writes it |`,
      ),
    '| `apply.yml` | The same steps as a playbook, in order |',
    '| `inventory/hosts.yml` | Where the devices are and how to reach them |',
    '| `change-record.md` | The record: pre-checks, steps, verification, back-out, sign-off |',
    '',
    '## Two ways to apply it',
    '',
    '**By hand.** Open a session on the device, capture the "before" commands from the record, paste the step files in order, verify after each one, then save:',
    '',
    ...platforms.map((platform) => `- ${PLATFORMS[platform].label}: \`${PLATFORMS[platform].save}\``),
    '',
    '**With Ansible.** Dry run first — this is the closest a network device has to a plan:',
    '',
    '```bash',
    'ansible-galaxy collection install -r requirements.yml',
    'ansible-playbook -i inventory apply.yml --check --diff',
    'ansible-playbook -i inventory apply.yml --diff --limit <device>',
    '```',
    '',
    '## Credentials',
    '',
    'None are written here. The inventory expects them from a vault:',
    '',
    '```bash',
    'ansible-vault create group_vars/all/vault.yml',
    '```',
    '',
    ...platforms.flatMap((platform) => [`**${PLATFORMS[platform].label}**`, '', '```yaml', ...inventoryHint(platform), '```', '']),
    '## Before you apply any of it',
    '',
    '- Diff every file against the running configuration. Generated configuration is a draft, not an approved change.',
    '- Check the impact line in the record and confirm the window.',
    '- Have the back-out open in a second window before you start.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

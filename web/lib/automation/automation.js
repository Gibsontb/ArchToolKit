/**
 * The automation model.
 *
 * An automation is not a script and it is not a configuration file. A script
 * runs when someone runs it, and a human is there to read the output. An
 * automation runs because something happened — an alert fired, a schedule came
 * round, a request was approved — and nobody is watching. It will act on
 * production at three in the morning, on whatever objects its scope happens to
 * match that night, and the first anyone hears of it is the change record, if
 * there is one.
 *
 * So the contract here is the one that matters for that:
 *
 *   Trigger      what starts it
 *   Scope        exactly which objects it may touch, and how wide that really is
 *   Guardrails   what has to be true before it acts
 *   Dry run      how to make it report instead of act
 *   Undo         how to reverse it, or an honest statement that you cannot
 *   Told         where the record goes when it does act
 *
 * The scope is the one people get wrong. An action wired to an alert inherits
 * the alert's scope, an alert inherits its policy's, a policy applies to a
 * custom group, and a custom group is a rule someone wrote a year ago. Four
 * indirections between "power off idle VMs" and which VMs that is tonight.
 *
 * Names follow VCF 9.1. VCF Operations, VCF Operations for Networks, VCF
 * Operations for Logs and VCF Automation are capabilities of one platform now
 * rather than four products, which is why an automation here can be triggered
 * in one and act in another. The Aria names are carried alongside, because
 * every runbook and half the documentation still says Aria.
 */

import { info, warning,              } from '../core/findings.js';

                                                                                                                                                    

                                         
                                  
                         
                                                               
                             
                                               
                               
                                                                  
                          
 

/**
 * The targets, as VCF 9.1 names them.
 *
 * These are not five products. In 9.1 they are capabilities of one platform,
 * under one fleet and one identity, and the interesting automations cross
 * between them — a log alert that fires a VCF Automation action, a network
 * intent violation that raises an operations alert. They are separate here only
 * because each one takes a different file.
 *
 * The old names are kept because every runbook, KB article and half the
 * interface still says Aria, and someone will be reading this with an 8.x
 * system in front of them.
 */
export const AUTOMATION_PLATFORMS                                                               = {
  'vcf-operations': {
    id: 'vcf-operations',
    label: 'VCF Operations',
    formerly: 'Aria Operations, vRealize Operations',
    appliedWith: 'The suite API, at /suite-api/api — or the interface, if you would rather click it once and export it afterwards.',
    dryRun: 'Run the scope query on its own first and count what comes back. Nothing here acts until you have seen that number.',
  },
  'vcf-operations-networks': {
    id: 'vcf-operations-networks',
    label: 'VCF Operations for Networks',
    formerly: 'Aria Operations for Networks, vRealize Network Insight, vRNI',
    appliedWith: 'The Networks API, at /api/ni — the same appliance in 9.1, a separate one before it.',
    dryRun: 'Every search here is a read. Run the search, look at the flows it returns, and only then let anything act on the result.',
  },
  'vcf-operations-logs': {
    id: 'vcf-operations-logs',
    label: 'VCF Operations for Logs',
    formerly: 'Aria Operations for Logs, vRealize Log Insight, vRLI',
    appliedWith: 'The Logs API, at /api/v2 — alert queries, content packs and webhooks.',
    dryRun: 'Run the query over the last day first. A log alert that matches ten thousand events an hour is a paging incident of its own.',
  },
  'vcf-automation': {
    id: 'vcf-automation',
    label: 'VCF Automation',
    formerly: 'Aria Automation, vRealize Automation, vRA',
    appliedWith: 'The Assembler and Service Broker APIs, or a content source pointed at the repository these files live in.',
    dryRun: 'Deploy to a project with no real cloud zone, or run the action with its dry-run input set.',
  },
  'vcf-fleet': {
    id: 'vcf-fleet',
    label: 'Fleet management and tags',
    formerly: 'SDDC Manager, Aria Suite Lifecycle, vRealize Suite Lifecycle Manager',
    appliedWith: 'The SDDC Manager API at /v1 for each instance, and fleet management in VCF Operations for the components it now owns.',
    dryRun: 'Every script here reads first and prints what it would rotate, replace or check. The acting half is behind --execute.',
  },
  pipeline: {
    id: 'pipeline',
    label: 'Pipelines and runners',
    appliedWith: 'Whichever runner the blueprint targets: Azure Automation, AWS Systems Manager, AWX, GitHub Actions or Azure Pipelines.',
    dryRun: 'Every generated runner takes a dry-run switch, and the schedule is created disabled.',
  },
};

/** What running it does to whatever it is pointed at. */
                              
                                                  
          
                                                           
                
                                                                     
                   

export const EFFECT_MEANING                                             = {
  read: 'Reads and reports. It changes nothing, so it is safe to leave running.',
  reversible: 'Changes something, and the change can be put back. The undo below says how.',
  irreversible: 'Deletes, destroys or spends money. Running it twice is not the risk; running it once on the wrong scope is.',
};

/** What starts it. */
                                    
                                                           
                                                                                    
                                                                                     
                          
                                                                                 
                              
 

/** Which objects it may touch. */
                                  
                                                                         
                        
                                                                         
                                        
                                                          
                           
 

/** Something that has to be true before it acts. */
                            
                        
                                                    
                           
 

                             
                                        
                                 
                         
                                    
                                      
                                  
                                            
                                               
                                     
                                                         
                                   
                                            
                                   
                                                  
                                       
                                              
                                                   
                                                       
                                     
                                         
 

const RULE = '-'.repeat(74);

function wrap(text        , width = 74)           {
  const words = text.split(/\s+/).filter(Boolean);
  const lines           = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

function section(heading        , lines                   )           {
  if (lines.length === 0) return [];
  return [`## ${heading}`, '', ...lines, ''];
}

/**
 * The README that travels with every automation.
 *
 * It is the same six questions every time, in the same order, because the
 * moment anybody asks them is the moment it has already done something
 * unexpected and nobody wants to read prose.
 */
export function renderReadme(automation            , name        )         {
  const platform = AUTOMATION_PLATFORMS[automation.platform];
  const lines           = [
    `# ${automation.title}`,
    '',
    ...wrap(EFFECT_MEANING[automation.effect]),
    '',
    `Generated by ArchToolKit for **${platform.label}**${platform.formerly ? ` (formerly ${platform.formerly})` : ''}.`,
    'Read this before you turn it on. An automation acts when nobody is watching.',
    '',
    RULE,
    '',
  ];

  lines.push(...section('Trigger', [
    `**${automation.trigger.kind}** — ${automation.trigger.detail}`,
    ...(automation.trigger.worstCase ? ['', `At worst it can fire ${automation.trigger.worstCase}. That is the number to size the guardrails against, not the number you expect.`] : []),
  ]));

  lines.push(...section('Scope — what it may touch', [
    automation.scope.what,
    '',
    'Decided by, in order:',
    ...automation.scope.decidedBy.map((step, index) => `${index + 1}. ${step}`),
    '',
    `**If the scope is wider than you think:** ${automation.scope.ifWrong}`,
  ]));

  lines.push(...section('Guardrails', automation.guardrails.flatMap((guard) => [`- **${guard.rule}**`, `  ${guard.because}`])));
  lines.push(...section('Dry run — report instead of act', automation.dryRun.map((step) => `- ${step}`)));
  lines.push(...section('Undo', automation.undo.map((step) => `- ${step}`)));
  lines.push(...section('Who is told when it acts', automation.told.map((step) => `- ${step}`)));
  lines.push(...section('What has to exist first', automation.requires.map((step) => `- ${step}`)));
  lines.push(...section('Applying it', [platform.appliedWith]));
  if (automation.notes && automation.notes.length > 0) lines.push(...section('Worth knowing', automation.notes.map((note) => `- ${note}`)));

  lines.push(...section('Files', Object.keys(automation.files).map((file) => `- \`${file}\``)));
  lines.push(RULE, '', 'No credential is written into any of these files. Where one is needed the file');
  lines.push('leaves `<REQUIRED>` or reads it from the runner’s own secret store, and says which.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/**
 * What is true of every automation, whatever it does.
 *
 * These are the four ways an automation goes wrong that are visible from the
 * definition rather than from watching it run.
 */
export function standingFindings(automation            )            {
  const findings            = [];

  if (automation.effect === 'irreversible') {
    const approved = automation.guardrails.some((guard) => /approv|confirm|ticket|change/i.test(guard.rule));
    findings.push(
      warning('automation.irreversible', `${automation.title} cannot be undone once it has run.`, {
        remediation: approved
          ? 'It has an approval or change guardrail, which is the right shape. Check that the approver is a person who can say no.'
          : 'Nothing here requires a human to agree before it acts. Add an approval step, or make the first version report only.',
        source: 'ArchToolKit',
      }),
    );
  }

  if (automation.guardrails.length === 0 && automation.effect !== 'read') {
    findings.push(
      warning('automation.no-guardrail', 'This automation changes something and has no guardrail on it.', {
        remediation: 'At minimum: a cap on how many objects one run may touch, and an exclusion tag that takes an object out of scope without editing the automation.',
        source: 'ArchToolKit',
      }),
    );
  }

  if (automation.trigger.kind === 'alert') {
    findings.push(
      info('automation.alert-scope', 'Its scope comes from the alert, and the alert’s scope comes from its policy, and the policy applies to a custom group.', {
        remediation: 'Before turning this on, open the group and count the members. That number is the blast radius, not the alert name.',
        source: 'ArchToolKit',
      }),
    );
  }

  findings.push(
    info('automation.first-run', 'Run it once with the dry run on, read every line of what it lists, and only then take the flag off.', {
      remediation: 'Most automation incidents are a correct automation pointed at the wrong set of objects. The dry run is the only place that is visible.',
      source: 'ArchToolKit',
    }),
  );

  return findings;
}

/** A name safe to use as a file name and an object name. */
export function slugOf(text        , fallback        )         {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/** Split a comma or newline separated list. */
export function listOf(text        )           {
  return text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

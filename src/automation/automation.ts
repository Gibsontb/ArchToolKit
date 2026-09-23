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

import { info, warning, type Finding } from '../core/findings.ts';

export type AutomationPlatform = 'vcf-operations' | 'vcf-operations-networks' | 'vcf-operations-logs' | 'vcf-automation' | 'vcf-fleet' | 'pipeline';

export interface AutomationPlatformInfo {
  readonly id: AutomationPlatform;
  readonly label: string;
  /** What it was called before VCF 9.1, where that differs. */
  readonly formerly?: string;
  /** Where the generated files are applied. */
  readonly appliedWith: string;
  /** What "report instead of act" looks like on this platform. */
  readonly dryRun: string;
}

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
export const AUTOMATION_PLATFORMS: Readonly<Record<AutomationPlatform, AutomationPlatformInfo>> = {
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
export type AutomationEffect =
  /** Reads and reports. Safe to leave running. */
  | 'read'
  /** Changes something, and the change can be put back. */
  | 'reversible'
  /** Deletes, destroys or spends money. There may be no way back. */
  | 'irreversible';

export const EFFECT_MEANING: Readonly<Record<AutomationEffect, string>> = {
  read: 'Reads and reports. It changes nothing, so it is safe to leave running.',
  reversible: 'Changes something, and the change can be put back. The undo below says how.',
  irreversible: 'Deletes, destroys or spends money. Running it twice is not the risk; running it once on the wrong scope is.',
};

/** What starts it. */
export interface AutomationTrigger {
  /** alert, schedule, request, webhook, commit, manual. */
  readonly kind: 'alert' | 'schedule' | 'request' | 'webhook' | 'commit' | 'manual';
  /** In words: "the datastore-full alert, on any object in the Production group". */
  readonly detail: string;
  /** How often it can fire at worst, which is not how often you expect it to. */
  readonly worstCase?: string;
}

/** Which objects it may touch. */
export interface AutomationScope {
  /** In words: "virtual machines in the custom group Production VMs". */
  readonly what: string;
  /** How that scope is actually decided, following every indirection. */
  readonly decidedBy: readonly string[];
  /** What happens if the scope is wider than intended. */
  readonly ifWrong: string;
}

/** Something that has to be true before it acts. */
export interface Guardrail {
  readonly rule: string;
  /** Why it is there — the incident it prevents. */
  readonly because: string;
}

export interface Automation {
  readonly platform: AutomationPlatform;
  /** What it does, in a line. */
  readonly title: string;
  readonly effect: AutomationEffect;
  readonly trigger: AutomationTrigger;
  readonly scope: AutomationScope;
  readonly guardrails: readonly Guardrail[];
  /** How to make it report rather than act. */
  readonly dryRun: readonly string[];
  /** How to reverse it, or why it cannot be reversed. */
  readonly undo: readonly string[];
  /** Where the record goes when it acts. */
  readonly told: readonly string[];
  /** What has to exist before any of it works. */
  readonly requires: readonly string[];
  /** The files it emits, already rendered. */
  readonly files: Readonly<Record<string, string>>;
  /** Anything the person turning it on has to know. */
  readonly notes?: readonly string[];
  readonly findings?: readonly Finding[];
}

const RULE = '-'.repeat(74);

function wrap(text: string, width = 74): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
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

function section(heading: string, lines: readonly string[]): string[] {
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
export function renderReadme(automation: Automation, name: string): string {
  const platform = AUTOMATION_PLATFORMS[automation.platform];
  const lines: string[] = [
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
export function standingFindings(automation: Automation): Finding[] {
  const findings: Finding[] = [];

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
export function slugOf(text: string, fallback: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/** Split a comma or newline separated list. */
export function listOf(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

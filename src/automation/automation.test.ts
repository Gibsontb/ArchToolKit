/**
 * The automation kit's own checks.
 *
 * The contract is the whole point of this kit, so the tests are about the
 * contract rather than about the YAML: every automation says what starts it and
 * what it may touch, anything irreversible has a guardrail, anything that
 * changes something has a dry run, and nothing anywhere writes a credential.
 *
 * Those four are exactly what gets dropped when somebody is in a hurry, which
 * is when automation gets written.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues } from '../kit/blueprint.ts';
import { hasErrors } from '../core/findings.ts';
import { AUTOMATION_BLUEPRINTS, AUTOMATIONS, automationFor } from './blueprints/index.ts';
import { AUTOMATION_PLATFORMS, EFFECT_MEANING, listOf, renderReadme, slugOf, type Automation } from './automation.ts';

/** Every automation, built from its own defaults. */
function everyAutomation(): { id: string; automation: Automation }[] {
  return AUTOMATIONS.map((blueprint) => ({ id: blueprint.id, automation: blueprint.automation(defaultValues(blueprint), blueprint.id) }));
}

describe('automation: the vocabulary', () => {
  it('makes a safe name out of whatever someone types', () => {
    expect(slugOf('Monthly Reclamation!', 'x')).toBe('monthly-reclamation');
    expect(slugOf('   ', 'fallback')).toBe('fallback');
  });

  it('reads a list written with commas or newlines', () => {
    expect(listOf('a, b\nc')).toEqual(['a', 'b', 'c']);
    expect(listOf('')).toEqual([]);
  });

  it('names every platform as VCF 9.1 does, and says what it used to be', () => {
    expect(AUTOMATION_PLATFORMS['vcf-operations'].label).toBe('VCF Operations');
    expect(AUTOMATION_PLATFORMS['vcf-automation'].label).toBe('VCF Automation');
    expect(AUTOMATION_PLATFORMS['vcf-operations-logs'].label).toBe('VCF Operations for Logs');
    expect(AUTOMATION_PLATFORMS['vcf-operations-networks'].label).toBe('VCF Operations for Networks');
    // VCF 9.1 names only: no old product name in any README written.
    for (const blueprint of AUTOMATIONS) {
      const readme = renderReadme(blueprint.automation(defaultValues(blueprint), blueprint.id), blueprint.id);
      expect([blueprint.id, /\b(Aria|vRealize)\b/.test(readme)]).toEqual([blueprint.id, false]);
    }
  });

  it('covers every platform with at least one blueprint', () => {
    for (const group of AUTOMATION_BLUEPRINTS) {
      expect(group.blueprints.length).toBeGreaterThan(0);
    }
    expect(AUTOMATION_BLUEPRINTS.length).toBe(5);
  });

  it('finds a blueprint by id', () => {
    expect(automationFor('vcfops_notify_webhook')?.platform).toBe('vcf-operations');
    expect(automationFor('nothing-like-this')).toBe(undefined);
  });
});

describe('automation: the contract every one of them keeps', () => {
  it('says what starts it, and what it may touch', () => {
    const missing: string[] = [];
    for (const { id, automation } of everyAutomation()) {
      if (!automation.trigger.detail.trim()) missing.push(`${id}: no trigger`);
      if (!automation.scope.what.trim()) missing.push(`${id}: no scope`);
      if (automation.scope.decidedBy.length === 0) missing.push(`${id}: does not say how the scope is decided`);
      if (!automation.scope.ifWrong.trim()) missing.push(`${id}: does not say what happens if the scope is wrong`);
    }
    expect(missing).toEqual([]);
  });

  it('gives anything that changes something a guardrail', () => {
    const missing = everyAutomation()
      .filter(({ automation }) => automation.effect !== 'read' && automation.guardrails.length === 0)
      .map(({ id }) => id);
    expect(missing).toEqual([]);
  });

  it('gives anything that changes something a way to report instead', () => {
    const missing = everyAutomation()
      .filter(({ automation }) => automation.effect !== 'read' && automation.dryRun.length === 0)
      .map(({ id }) => id);
    expect(missing).toEqual([]);
  });

  it('says how to undo it, or says honestly that you cannot', () => {
    const missing = everyAutomation()
      .filter(({ automation }) => automation.undo.length === 0)
      .map(({ id }) => id);
    expect(missing).toEqual([]);
  });

  it('says who is told when it acts', () => {
    const missing = everyAutomation()
      .filter(({ automation }) => automation.told.length === 0)
      .map(({ id }) => id);
    expect(missing).toEqual([]);
  });

  it('never writes a credential into a generated file', () => {
    // A value read from an environment variable, a secret store or a managed
    // identity is fine. A literal in quotes is not.
    const assignsLiteral = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
    const offenders: string[] = [];
    for (const { id, automation } of everyAutomation()) {
      for (const [file, body] of Object.entries(automation.files)) {
        for (const line of body.split('\n')) {
          if (assignsLiteral.test(line)) offenders.push(`${id} → ${file}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('builds clean from its own defaults', () => {
    const broken: string[] = [];
    for (const blueprint of AUTOMATIONS) {
      const out = blueprint.build(defaultValues(blueprint), blueprint.id);
      if (hasErrors(out.findings ?? [])) {
        broken.push(`${blueprint.id}: ${(out.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.code).join(', ')}`);
      }
      if (Object.keys(out.files).length < 2) broken.push(`${blueprint.id}: expected files and a README`);
      if (!out.files['README.md']) broken.push(`${blueprint.id}: no README`);
    }
    expect(broken).toEqual([]);
  });

  it('puts the six questions in every README, in the same order every time', () => {
    for (const { id, automation } of everyAutomation()) {
      const readme = renderReadme(automation, id);
      for (const heading of ['## Trigger', '## Scope — what it may touch', '## Guardrails', '## Dry run', '## Undo', '## Who is told when it acts']) {
        if (automation.guardrails.length === 0 && heading === '## Guardrails') continue;
        expect(readme.includes(heading)).toBe(true);
      }
      // The effect is wrapped to 74 columns in the README, so compare against
      // the text with its line breaks collapsed rather than line by line.
      const flat = readme.replace(/\s+/g, ' ');
      expect(flat.includes(EFFECT_MEANING[automation.effect])).toBe(true);
    }
  });
});

describe('automation: the ones with a known trap in them', () => {
  it('calls a blocking extensibility action that fails closed an error', () => {
    const blueprint = automationFor('vcfa_abx_action');
    if (!blueprint) throw new Error('missing blueprint');
    const out = blueprint.build({ ...defaultValues(blueprint), topic: 'compute.allocation.pre', fail_open: false }, 'x');
    const codes = (out.findings ?? []).map((finding) => finding.code);
    expect(codes.includes('vcfa.abx.blocking-fail-closed')).toBe(true);
    expect(hasErrors(out.findings ?? [])).toBe(true);
  });

  it('refuses to let an approval policy approve what nobody answered', () => {
    const blueprint = automationFor('vcfa_approval_policy');
    if (!blueprint) throw new Error('missing blueprint');
    const out = blueprint.build({ ...defaultValues(blueprint), on_expiry: 'APPROVE' }, 'x');
    expect((out.findings ?? []).some((finding) => finding.code === 'vcfa.approval.auto-approve')).toBe(true);
  });

  it('notices a webhook with a secret in its query string', () => {
    const blueprint = automationFor('vcfops_notify_webhook');
    if (!blueprint) throw new Error('missing blueprint');
    const out = blueprint.build({ ...defaultValues(blueprint), endpoint: 'https://hooks.example.com/x?token=abc123' }, 'x');
    expect((out.findings ?? []).some((finding) => finding.code === 'vcfops.rule.secret-in-url')).toBe(true);
  });

  it('notices a maintenance window that nothing checks has ended', () => {
    const blueprint = automationFor('vcfops_maintenance_window');
    if (!blueprint) throw new Error('missing blueprint');
    const out = blueprint.build({ ...defaultValues(blueprint), alert_on_overrun: false }, 'x');
    expect((out.findings ?? []).some((finding) => finding.code === 'vcfops.window.no-overrun-check')).toBe(true);
  });

  it('creates schedules enabled, whatever the platform', () => {
    const shouldBeEnabled = ['vcfops_reclaim_schedule'];
    for (const id of shouldBeEnabled) {
      const blueprint = automationFor(id);
      if (!blueprint) throw new Error(`missing ${id}`);
      const files = blueprint.build(defaultValues(blueprint), id).files;
      const text = Object.values(files).join('\n');
      // Nothing is created disabled, and a cron schedule is a live line, not a commented one.
      expect(/"enabled":\s*false|isEnabled: false|enabled: false/.test(text)).toBe(false);
      if ('crontab.txt' in files) expect(files['crontab.txt']!.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#'))).toBe(true);
    }
  });
});

describe('automation: every choice, not just the defaults', () => {
  it('has one id per blueprint', () => {
    const ids = AUTOMATIONS.map((blueprint) => blueprint.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('keeps the contract and writes no credential whichever option is picked', () => {
    // Defaults are what the page opens on; the other options are what people
    // actually choose. Each select option and each toggle flipped is built once.
    const assignsLiteral = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
    const problems: string[] = [];
    for (const blueprint of AUTOMATIONS) {
      const base = defaultValues(blueprint);
      const variants: Record<string, string | number | boolean | undefined>[] = [{ ...base }];
      for (const input of blueprint.inputs) {
        if (input.control === 'select') for (const option of input.options ?? []) variants.push({ ...base, [input.id]: option.value });
        if (input.control === 'toggle') variants.push({ ...base, [input.id]: !base[input.id] });
      }
      for (const values of variants) {
        let automation: Automation;
        try {
          automation = blueprint.automation(values, blueprint.id);
        } catch (failure) {
          problems.push(`${blueprint.id} ${JSON.stringify(values)}: threw ${String(failure)}`);
          continue;
        }
        if (!automation.trigger.detail.trim() || !automation.scope.what.trim() || automation.undo.length === 0 || automation.told.length === 0) {
          problems.push(`${blueprint.id}: contract field empty for ${JSON.stringify(values)}`);
        }
        if (automation.effect !== 'read' && (automation.guardrails.length === 0 || automation.dryRun.length === 0)) {
          problems.push(`${blueprint.id}: changes something with no guardrail or dry run for ${JSON.stringify(values)}`);
        }
        for (const [file, body] of Object.entries(automation.files)) {
          for (const line of body.split('\n')) if (assignsLiteral.test(line)) problems.push(`${blueprint.id} → ${file}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('never puts a token or session id on a command line', () => {
    // An argument is visible to every user on the host through ps and /proc.
    // Headers carrying a secret come from a private file or a process
    // substitution instead.
    const onArgv = /-H "?(Authorization|x-hm-authorization|vmware-api-session-id): *[A-Za-z]* *\$/;
    const problems: string[] = [];
    for (const blueprint of AUTOMATIONS) {
      const base = defaultValues(blueprint);
      const variants: Record<string, string | number | boolean | undefined>[] = [{ ...base }];
      for (const input of blueprint.inputs) {
        if (input.control === 'select') for (const option of input.options ?? []) variants.push({ ...base, [input.id]: option.value });
        if (input.control === 'toggle') variants.push({ ...base, [input.id]: !base[input.id] });
      }
      for (const values of variants) {
        for (const [file, body] of Object.entries(blueprint.automation(values, blueprint.id).files)) {
          if (!/\.(sh|bash)$/.test(file) && !body.startsWith('#!/usr/bin/env bash')) continue;
          body.split('\n').forEach((line, index) => {
            if (onArgv.test(line)) problems.push(`${blueprint.id} → ${file}:${index + 1}`);
          });
        }
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('covers setup, content and automation on every VCF platform', () => {
    const count = (target: string) => AUTOMATION_BLUEPRINTS.find((group) => group.target === target)?.blueprints.length ?? 0;
    expect(count('vcf-operations')).toBeGreaterThan(30);
    expect(count('vcf-automation')).toBeGreaterThan(30);
    expect(count('vcf-fleet')).toBeGreaterThan(20);
    expect(count('vcf-operations-logs')).toBeGreaterThan(5);
    expect(AUTOMATION_BLUEPRINTS.some((group) => String(group.target) === 'pipeline')).toBe(false);
  });
});

describe('automation: traps in the setup and fleet kits', () => {
  const findingsOf = (id: string, overrides: Record<string, string | number | boolean>) => {
    const blueprint = automationFor(id);
    if (!blueprint) throw new Error(`missing ${id}`);
    return (blueprint.build({ ...defaultValues(blueprint), ...overrides }, 'x').findings ?? []).map((finding) => finding.code);
  };

  it('refuses to collect from a vCenter as its built-in administrator', () => {
    expect(findingsOf('vcfops_adapter_instance', { account: 'administrator@vsphere.local' }).includes('vcfops.adapter.admin-account')).toBe(true);
  });

  it('refuses to automate an action in the default policy', () => {
    expect(findingsOf('vcfops_alert_action', { policy_name: 'Default Policy' }).includes('vcfops.action.default-policy')).toBe(true);
  });

  it('catches an alert whose critical threshold is not beyond its warning', () => {
    expect(findingsOf('vcfops_alert_definition', { warning_at: 90, critical_at: 80 }).includes('vcfops.alert.inverted')).toBe(true);
  });

  it('catches a retired Teams connector URL', () => {
    expect(findingsOf('vcfops_webhook_payload', { destination: 'teams', endpoint: 'https://example.webhook.office.com/webhookb2/abc' }).includes('vcfops.payload.teams-connector')).toBe(true);
  });
});

describe('automation: tags, which everything else scopes by', () => {
  const build = (id: string, overrides: Record<string, string | number | boolean> = {}) => {
    const blueprint = automationFor(id);
    if (!blueprint) throw new Error(`missing ${id}`);
    return blueprint.build({ ...defaultValues(blueprint), ...overrides }, 'x');
  };
  const codes = (id: string, overrides: Record<string, string | number | boolean>) => (build(id, overrides).findings ?? []).map((finding) => finding.code);

  it('has the whole tagging programme: standard, assign, rules, govern, use, clean', () => {
    for (const id of ['tags_taxonomy', 'tags_bulk_assign', 'tags_rules', 'tags_compliance', 'tags_sync_control', 'tags_backup', 'tags_consume', 'tags_cleanup']) {
      expect(automationFor(id)?.platform).toBe('vcf-fleet');
    }
    const group = AUTOMATION_BLUEPRINTS.find((candidate) => candidate.target === 'vcf-fleet');
    expect(group?.blueprints[0]?.id).toBe('tags_taxonomy');
  });

  it('says so when a category that must hold one value allows many', () => {
    expect(codes('tags_taxonomy', { standard: 'Environment | multiple | VirtualMachine | prod,test,dev | VirtualMachine | Where it runs' }).includes('tags.standard.should-be-single')).toBe(true);
  });

  it('refuses a standard with the same category twice', () => {
    const line = 'Environment | single | VirtualMachine | prod,test | VirtualMachine | Where it runs';
    expect(codes('tags_taxonomy', { standard: `${line}\n${line}` }).includes('tags.standard.duplicate-category')).toBe(true);
  });

  it('warns when placement or NSX groups hang off a category that allows many values', () => {
    const found = codes('tags_consume', {});
    const standard = 'Environment | multiple | VirtualMachine | prod,test | VirtualMachine | x\nApplication | multiple | VirtualMachine | pay,web | VirtualMachine | x\nCostCenter | single | VirtualMachine | CC1 | VirtualMachine | x';
    expect(found.includes('tags.consume.placement-multiple')).toBe(false);
    expect(codes('tags_consume', { standard }).includes('tags.consume.placement-multiple')).toBe(true);
  });

  it('never deletes a tag without exporting first, and never one still attached', () => {
    const files = build('tags_cleanup').files;
    const script = Object.entries(files).find(([name]) => name.endsWith('.sh') && /cleanup/.test(name))?.[1] ?? Object.values(files).join('\n');
    expect(/export|backup/i.test(script)).toBe(true);
    expect(/attached/i.test(script)).toBe(true);
    expect(/--dry-run/.test(script)).toBe(true);
  });
});

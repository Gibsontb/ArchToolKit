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
import { AUTOMATION_PLATFORMS, EFFECT_MEANING, listOf, renderReadme, slugOf, standingFindings, type Automation } from './automation.ts';

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
    // The old names have to be here: every runbook and half the interface still
    // says Aria, and somebody will be reading this with 8.x in front of them.
    for (const id of ['vcf-operations', 'vcf-automation', 'vcf-operations-logs', 'vcf-operations-networks'] as const) {
      expect((AUTOMATION_PLATFORMS[id].formerly ?? '').toLowerCase().includes('aria')).toBe(true);
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

describe('automation: the standing findings', () => {
  it('warns when something irreversible has nobody agreeing to it first', () => {
    const base: Automation = {
      platform: 'vcf-operations',
      title: 'Delete things',
      effect: 'irreversible',
      trigger: { kind: 'schedule', detail: 'nightly' },
      scope: { what: 'everything', decidedBy: ['a group'], ifWrong: 'bad' },
      guardrails: [],
      dryRun: ['report first'],
      undo: ['you cannot'],
      told: ['a log'],
      requires: [],
      files: {},
    };
    const codes = standingFindings(base).map((finding) => finding.code);
    expect(codes.includes('automation.irreversible')).toBe(true);
    expect(codes.includes('automation.no-guardrail')).toBe(true);

    const guarded = standingFindings({ ...base, guardrails: [{ rule: 'A change ticket is required', because: 'because' }] }).map((f) => f.code);
    expect(guarded.includes('automation.no-guardrail')).toBe(false);
  });

  it('always says to follow the scope chain when the trigger is an alert', () => {
    const codes = standingFindings({
      platform: 'vcf-operations',
      title: 'x',
      effect: 'read',
      trigger: { kind: 'alert', detail: 'an alert' },
      scope: { what: 'x', decidedBy: ['x'], ifWrong: 'x' },
      guardrails: [],
      dryRun: [],
      undo: ['nothing'],
      told: ['x'],
      requires: [],
      files: {},
    }).map((finding) => finding.code);
    expect(codes.includes('automation.alert-scope')).toBe(true);
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

  it('calls a log alert with no rate limit an error', () => {
    const blueprint = automationFor('vcflog_alert_webhook');
    if (!blueprint) throw new Error('missing blueprint');
    const out = blueprint.build({ ...defaultValues(blueprint), rate_limit_minutes: 0 }, 'x');
    expect((out.findings ?? []).some((finding) => finding.code === 'vcflog.alert.no-rate-limit')).toBe(true);
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

  it('notices a pipeline that applies to production with nobody in the loop', () => {
    const blueprint = automationFor('pipe_ci_terraform');
    if (!blueprint) throw new Error('missing blueprint');
    const out = blueprint.build({ ...defaultValues(blueprint), auto_apply: true, require_approval: false }, 'x');
    expect((out.findings ?? []).some((finding) => finding.code === 'pipe.ci.unattended-apply')).toBe(true);
  });

  it('creates schedules disabled, whatever the platform', () => {
    const shouldBeDisabled = ['vcfops_reclaim_schedule', 'vcflog_alert_webhook', 'pipe_azure_runbook'];
    for (const id of shouldBeDisabled) {
      const blueprint = automationFor(id);
      if (!blueprint) throw new Error(`missing ${id}`);
      const text = Object.values(blueprint.build(defaultValues(blueprint), id).files).join('\n');
      expect(/"enabled":\s*false|isEnabled: false|enabled: false/.test(text)).toBe(true);
    }
  });
});

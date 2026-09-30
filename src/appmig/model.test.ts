import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { BUILT, CARDS, HOSTING_PLATFORMS, SCREENS, SOURCE_ENVIRONMENTS, VENDORS, continuityProblems, continuityProgress, continuitySignals, displayName, identityProblems, identityProgress, identitySignals, loadProblems, loadSignals, newApp, normalizeApp, screenBuilt, vendorLabel } from './model.ts';

const app = (name = '') => {
  const a = newApp(crypto.randomUUID(), '2026-09-29T10:00:00.000Z');
  a.identity.name = name;
  return a;
};

describe('appmig: card 1, identity', () => {
  it('starts empty: nothing is filled in for the user', () => {
    const a = app();
    expect(Object.values(a.identity).every((v) => v === '')).toBe(true);
    expect(displayName(a)).toBe('Untitled application');
  });

  it('asks for a name, and refuses one another application already has', () => {
    expect(identityProblems(app(), []).map((p) => p.field)).toEqual(['name']);
    const payroll = app('Payroll');
    expect(identityProblems(app('payroll '), [payroll])[0]?.message).toBe('Another application is already called "payroll".');
    expect(identityProblems(payroll, [payroll])).toEqual([]);
  });

  it('asks for the name behind "Other"', () => {
    const a = app('Payroll');
    a.identity.vendor = 'Other';
    a.identity.hostingPlatform = 'Other';
    expect(identityProblems(a, []).map((p) => p.field)).toEqual(['vendorOther', 'hostingOther']);
    a.identity.vendorOther = 'Acme';
    expect(vendorLabel(a.identity)).toBe('Acme');
  });

  it('counts what is answered', () => {
    const a = app('Payroll');
    a.identity.vendor = 'SAP';
    expect(identityProgress(a.identity)).toEqual({ answered: 2, of: 8 });
  });

  it('reports what the answers mean without deciding', () => {
    const a = app('Payroll');
    a.identity.hostingPlatform = 'Mainframe';
    expect(identitySignals(a.identity).some((s) => s.includes('mainframe'))).toBe(true);
    expect(identitySignals(app('x').identity)).toEqual([]);
  });

  it('keeps closed sets, each with Other where the original had free text', () => {
    expect(VENDORS.at(-1)?.value).toBe('Other');
    expect(HOSTING_PLATFORMS.at(-1)?.value).toBe('Other');
    expect(SOURCE_ENVIRONMENTS.length).toBe(6);
    expect(new Set(VENDORS.map((v) => v.value)).size).toBe(VENDORS.length);
  });

  it('lists all twelve Stage 1 sections on four screens, with the assessment last', () => {
    expect(CARDS.length).toBe(12);
    expect(SCREENS.flatMap((s) => [...s.cards]).sort()).toEqual(CARDS.map((c) => c.id).sort());
    expect(SCREENS.at(-1)?.id).toBe('assessment');
    expect(SCREENS.filter(screenBuilt).length).toBe(5);
    expect(BUILT.size).toBe(12);
  });

  it('gives a record saved before a section existed that section, empty', () => {
    const old = { id: 'x', created: '', updated: '', identity: { name: 'Old' } } as never;
    const a = normalizeApp(old);
    expect(a.identity.vendor).toBe('');
    expect(a.continuity.environments).toEqual([]);
    expect(a.load.gpu).toBe('');
  });
});

describe('appmig: criticality and continuity', () => {
  it('asks for the environments, and the non-prod scale only when non-prod is in scope', () => {
    const c = app('A').continuity;
    expect(continuityProblems(c)).toEqual(['Tick the environments in scope.']);
    c.environments = ['prod'];
    expect(continuityProblems(c)).toEqual([]);
    expect(continuityProgress(c).of).toBe(6);
    c.environments = ['dev', 'prod'];
    expect(continuityProblems(c).length).toBe(1);
    expect(continuityProgress(c).of).toBe(7);
  });

  it('warns on a weak uptime target for the tier and on DR short of the targets', () => {
    const c = app('A').continuity;
    Object.assign(c, { criticality: 'tier0', uptime: '99.9', rto: 'mins', rpo: 'zero', drToday: 'backup' });
    const said = continuitySignals(c).join(' ');
    expect(said.includes('weak for its tier')).toBe(true);
    expect(said.includes('backup and restore will not meet it')).toBe(true);
    expect(said.includes('has to build the DR')).toBe(true);
    expect(said.includes('synchronous replication')).toBe(true);
    expect(continuitySignals(app('B').continuity)).toEqual([]);
  });
});

describe('appmig: users and load', () => {
  it('takes whole numbers only, and bands traffic as the wizard did', () => {
    const l = app('A').load;
    l.peakUsers = 'lots';
    expect(loadProblems(l).length).toBe(1);
    l.peakUsers = '60,000';
    expect(loadProblems(l)).toEqual([]);
    expect(loadSignals(l)[0]?.startsWith('High traffic band')).toBe(true);
    l.peakUsers = '200';
    expect(loadSignals(l)[0]?.startsWith('Low traffic band')).toBe(true);
  });
});

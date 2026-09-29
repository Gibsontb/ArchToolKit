import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { BUILT, CARDS, HOSTING_PLATFORMS, SOURCE_ENVIRONMENTS, VENDORS, displayName, identityProblems, identityProgress, identitySignals, newApp, vendorLabel } from './model.ts';

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

  it('lists all twelve Stage 1 cards, with only the built ones open', () => {
    expect(CARDS.length).toBe(12);
    expect([...BUILT]).toEqual(['identity']);
  });
});

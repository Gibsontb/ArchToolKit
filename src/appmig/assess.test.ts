import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { CARDS, newApp } from './model.ts';
import { FIELDS, RATINGS } from './sections.ts';
import { answersFor, problems, progress, readiness, risk, signals, suggestedRoute } from './assess.ts';

const fresh = () => {
  const a = newApp(crypto.randomUUID(), '2026-09-29T10:00:00.000Z');
  a.identity.name = 'Case Management';
  return a;
};

const rate = (app: ReturnType<typeof fresh>, values: number[]) => {
  const r = answersFor(app, 'ratings');
  RATINGS.forEach((x, i) => (r[x.key] = String(values[i])));
};

describe('appmig: every section is defined', () => {
  it('has fields for all twelve sections, with unique keys and closed sets on every dropdown', () => {
    for (const c of CARDS) {
      const fields = FIELDS[c.id];
      expect([c.id, fields.length > 0]).toEqual([c.id, true]);
      expect([c.id, new Set(fields.map((f) => f.key)).size]).toEqual([c.id, fields.length]);
      for (const f of fields) if (f.kind === 'select' || f.kind === 'checks') expect([c.id, f.key, (f.options ?? []).length > 0]).toEqual([c.id, f.key, true]);
    }
  });

  it('counts what is answered in a later section, and checks numbers in rows', () => {
    const app = fresh();
    expect(progress(app, 'data').answered).toBe(0);
    answersFor(app, 'data')['sensitivity'] = 'regulated';
    expect(progress(app, 'data').answered).toBe(1);
    answersFor(app, 'servers')['servers'] = [{ name: 'web01', vcpu: 'four' }];
    expect(problems(app, 'servers', [app])).toEqual(['Servers, row 1: vCPU should be a number.']);
  });
});

describe('appmig: the evaluator’s score, gates, risk and route', () => {
  it('has no score until all six ratings are given', () => {
    const app = fresh();
    expect(readiness(app)).toBeNull();
    expect(suggestedRoute(app)).toBeNull();
  });

  it('scores 100 when everything is easiest, and inverts the ratings where high is bad', () => {
    const app = fresh();
    rate(app, [5, 1, 1, 1, 5, 1]);
    expect(readiness(app)).toBe(100);
    expect(suggestedRoute(app)?.route).toBe('refactor');
    rate(app, [3, 3, 3, 3, 3, 3]);
    expect(readiness(app)).toBe(50);
    expect(suggestedRoute(app)?.route).toBe('rehost');
  });

  it('lets the gates settle the route first, in the evaluator’s order', () => {
    const app = fresh();
    rate(app, [5, 1, 1, 1, 5, 1]);
    answersFor(app, 'gates')['gates'] = ['saas', 'mainframe'];
    expect(suggestedRoute(app)?.route).toBe('repurchase');
    answersFor(app, 'gates')['gates'] = ['saas', 'mustStay'];
    expect(suggestedRoute(app)?.route).toBe('retain');
    answersFor(app, 'gates')['gates'] = ['obsolete', 'saas'];
    expect(suggestedRoute(app)?.route).toBe('retire');
  });

  it('adds up risk the way the evaluator did', () => {
    const app = fresh();
    Object.assign(app.continuity, { criticality: 'tier0', rto: 'mins', rpo: 'zero' });
    answersFor(app, 'security')['compliance'] = ['fedramp_moderate'];
    const r = risk(app);
    expect(r.points).toBe(9);
    expect(r.level).toBe('High');
  });

  it('reports what the later sections mean, in step order', () => {
    const app = fresh();
    answersFor(app, 'servers')['servers'] = [{ os: 'AIX', vcpu: '8', ramGb: '64', diskGb: '500' }];
    answersFor(app, 'network')['exposure'] = 'internet';
    const said = signals(app);
    expect(said.map((s) => s.card)).toEqual(['Servers', 'Network and perimeter']);
    expect(said[0]?.says.some((x) => x.includes('AIX'))).toBe(true);
  });
});

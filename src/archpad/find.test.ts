import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegExp, expandReplacement, findAll, findFrom, findLines, replaceAllText, unescapeExtended, type FindOptions } from './find.ts';

const opts = (query: string, extra: Partial<FindOptions> = {}): FindOptions => ({ query, matchCase: false, wholeWord: false, mode: 'normal', ...extra });

test('extended escapes', () => {
  assert.equal(unescapeExtended('a\\nb\\tc\\r\\0\\\\'), 'a\nb\tc\r\0\\');
  assert.equal(unescapeExtended('\\x41\\u00e9\\o101\\d065\\b01000001'), 'AéAAA');
  assert.equal(unescapeExtended('\\q\\x4'), '\\q\\x4');
});

test('normal mode is literal and case-insensitive by default', () => {
  const re = buildRegExp(opts('a.b'));
  assert.equal(findAll('A.B axb a.b', re).length, 2);
  assert.equal(findAll('A.B a.b', buildRegExp(opts('a.b', { matchCase: true }))).length, 1);
});

test('whole word uses Unicode letters, not just ASCII', () => {
  const re = buildRegExp(opts('vlan', { wholeWord: true }));
  // "vlan-10" counts: a hyphen is not part of a word.
  assert.deepEqual(findAll('vlan vlans novlan vlan10 vlan-10 vlan', re).map((m) => m.from), [0, 25, 33]);
  assert.equal(findAll('déjà vu', buildRegExp(opts('j', { wholeWord: true }))).length, 0);
  // A pattern invalid under the u flag still works through the ASCII fallback.
  assert.equal(findAll('a-b', buildRegExp(opts('a\\-b', { mode: 'regex', wholeWord: true }))).length, 1);
});

test('extended mode finds line breaks and tabs', () => {
  assert.equal(findAll('a\tb\nc', buildRegExp(opts('\\t', { mode: 'extended' }))).length, 1);
  assert.equal(findAll('x\ny', buildRegExp(opts('x\\ny', { mode: 'extended' }))).length, 1);
});

test('regex mode is multi-line and reports errors', () => {
  const re = buildRegExp(opts('^interface (\\S+)', { mode: 'regex' }));
  const found = findAll('interface Gi1\n desc\ninterface Gi2', re);
  assert.deepEqual(found.map((m) => m.groups[1]), ['Gi1', 'Gi2']);
  assert.throws(() => buildRegExp(opts('(unclosed', { mode: 'regex' })));
  assert.throws(() => buildRegExp(opts('')));
});

test('zero-length matches never loop', () => {
  const re = buildRegExp(opts('^', { mode: 'regex' }));
  assert.equal(findAll('a\nb\nc', re).length, 3);
  assert.equal(findAll('', buildRegExp(opts('x*', { mode: 'regex' }))).length, 1);
});

test('findAll honours a range', () => {
  const re = buildRegExp(opts('ab'));
  assert.deepEqual(findAll('ab ab ab', re, 2, 6).map((m) => m.from), [3]);
});

test('find next and previous, with and without wrap', () => {
  const text = 'one two one two';
  const re = buildRegExp(opts('one'));
  assert.equal(findFrom(text, re, 1, false, false)?.match.from, 8);
  assert.equal(findFrom(text, re, 9, false, false), null);
  assert.deepEqual(findFrom(text, re, 9, false, true), { match: { from: 0, to: 3, groups: ['one'], named: undefined }, wrapped: true });
  assert.equal(findFrom(text, re, 8, true, false)?.match.from, 0);
  assert.equal(findFrom(text, re, 2, true, false), null);
  assert.equal(findFrom(text, re, 2, true, true)?.match.from, 8);
});

test('regex replacement groups and escapes', () => {
  const re = buildRegExp(opts('(\\w+)@(?<host>\\w+)', { mode: 'regex' }));
  const m = findAll('user@example', re)[0]!;
  assert.equal(expandReplacement('$2:$1', m, 'regex'), 'example:user');
  assert.equal(expandReplacement('\\2\\t\\1', m, 'regex'), 'example\tuser');
  assert.equal(expandReplacement('${host}-$&-$$', m, 'regex'), 'example-user@example-$');
  assert.equal(expandReplacement('$1\\n', m, 'normal'), '$1\\n');
  assert.equal(expandReplacement('a\\nb', m, 'extended'), 'a\nb');
});

test('replace all returns the text and the count', () => {
  assert.deepEqual(replaceAllText('a1 b22 c333', opts('\\d+', { mode: 'regex' }), '<$&>'), { text: 'a<1> b<22> c<333>', count: 3 });
  assert.deepEqual(replaceAllText('x\ny\nz', opts('\\n', { mode: 'extended' }), ','), { text: 'x,y,z', count: 2 });
});

test('findLines reports 1-based lines, columns and line text', () => {
  const hits = findLines('alpha\r\nbeta alpha\ngamma', opts('alpha'));
  assert.deepEqual(
    hits.map((h) => [h.line, h.column, h.lineText]),
    [
      [1, 0, 'alpha'],
      [2, 5, 'beta alpha'],
    ],
  );
});

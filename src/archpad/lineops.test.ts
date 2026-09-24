import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  columnInsert,
  columnNumbers,
  convertCase,
  joinLines,
  removeBlankLines,
  removeConsecutiveDuplicates,
  removeDuplicates,
  removeEmptyLines,
  reverseLines,
  sortLines,
  spacesToTabs,
  splitLines,
  squeezeBlankLines,
  tabsToSpaces,
  transposeLines,
  trimBoth,
  trimLeading,
  trimTrailing,
} from './lineops.ts';

test('lexicographic sorts, with and without case', () => {
  const lines = ['banana', 'Apple', 'cherry', 'apple'];
  assert.deepEqual(sortLines(lines, 'asc'), ['Apple', 'apple', 'banana', 'cherry']);
  assert.deepEqual(sortLines(lines, 'desc'), ['cherry', 'banana', 'apple', 'Apple']);
  assert.deepEqual(sortLines(['b', 'B', 'a', 'A'], 'asc-ci'), ['A', 'a', 'B', 'b']);
  assert.deepEqual(sortLines(['b', 'B', 'a', 'A'], 'desc-ci'), ['b', 'B', 'a', 'A']);
});

test('numeric sort reads the leading number and puts the rest last', () => {
  const lines = ['10 ten', '9 nine', 'x', '-1.5 neg', '100', '2'];
  assert.deepEqual(sortLines(lines, 'num-asc'), ['-1.5 neg', '2', '9 nine', '10 ten', '100', 'x']);
  assert.deepEqual(sortLines(lines, 'num-desc'), ['100', '10 ten', '9 nine', '2', '-1.5 neg', 'x']);
});

test('length sort is stable', () => {
  assert.deepEqual(sortLines(['ccc', 'a', 'bb', 'd'], 'len-asc'), ['a', 'd', 'bb', 'ccc']);
  assert.deepEqual(sortLines(['ccc', 'a', 'bb', 'd'], 'len-desc'), ['ccc', 'bb', 'a', 'd']);
});

test('locale sort understands numbers inside text', () => {
  assert.deepEqual(sortLines(['Gi1/10', 'Gi1/2', 'Gi1/1'], 'locale-asc'), ['Gi1/1', 'Gi1/2', 'Gi1/10']);
});

test('duplicate removal', () => {
  assert.deepEqual(removeDuplicates(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
  assert.deepEqual(removeConsecutiveDuplicates(['a', 'a', 'b', 'a', 'a']), ['a', 'b', 'a']);
});

test('empty versus blank lines', () => {
  const lines = ['a', '', '  ', '\t', 'b'];
  assert.deepEqual(removeEmptyLines(lines), ['a', '  ', '\t', 'b']);
  assert.deepEqual(removeBlankLines(lines), ['a', 'b']);
  assert.deepEqual(squeezeBlankLines(['a', '', '', ' ', 'b', '', 'c']), ['a', '', 'b', '', 'c']);
});

test('reverse, join, split and transpose', () => {
  assert.deepEqual(reverseLines(['1', '2', '3']), ['3', '2', '1']);
  assert.deepEqual(joinLines(['  first  ', '   second', '', 'third ']), ['  first second third']);
  assert.deepEqual(splitLines(['the quick brown fox jumps'], 10), ['the quick', 'brown fox', 'jumps']);
  assert.deepEqual(splitLines(['  indented words here'], 11),['  indented', '  words', '  here']);
  assert.deepEqual(splitLines(['short'], 10), ['short']);
  assert.deepEqual(transposeLines(['a', 'b', 'c'], 2), ['a', 'c', 'b']);
});

test('trims', () => {
  assert.deepEqual(trimTrailing(['  a  ', 'b\t']), ['  a', 'b']);
  assert.deepEqual(trimLeading(['  a  ', '\tb']), ['a  ', 'b']);
  assert.deepEqual(trimBoth(['  a  ']), ['a']);
});

test('tabs and spaces honour tab stops', () => {
  assert.deepEqual(tabsToSpaces(['\tx', 'ab\tc'], 4), ['    x', 'ab  c']);
  assert.deepEqual(tabsToSpaces(['\tx\ty'], 4, true), ['    x\ty']);
  assert.deepEqual(spacesToTabs(['        x'], 4), ['\t\tx']);
  assert.deepEqual(spacesToTabs(['    x    y'], 4, true), ['\tx    y']);
  assert.deepEqual(spacesToTabs(['ab  c'], 4), ['ab\tc']);
});

test('case conversions', () => {
  assert.equal(convertCase('Hello World', 'upper'), 'HELLO WORLD');
  assert.equal(convertCase('Hello World', 'lower'), 'hello world');
  assert.equal(convertCase('hELLO wORLD of BGP', 'proper'), 'Hello World Of Bgp');
  assert.equal(convertCase('hello world of BGP', 'proper-blend'), 'Hello World Of BGP');
  assert.equal(convertCase('first ONE. second one! third', 'sentence'), 'First one. Second one! Third');
  assert.equal(convertCase('Hello World', 'invert'), 'hELLO wORLD');
  let flip = 0;
  assert.equal(convertCase('abcd', 'random', () => (flip++ % 2 ? 0.9 : 0.1)), 'aBcD');
});

test('column editor numbers: step, repeat, radix and padding', () => {
  assert.deepEqual(columnNumbers(4, { initial: 1, step: 1 }), ['1', '2', '3', '4']);
  assert.deepEqual(columnNumbers(5, { initial: 0, step: 5, pad: 'zeros' }), ['00', '05', '10', '15', '20']);
  assert.deepEqual(columnNumbers(4, { initial: 10, step: 10, repeat: 2 }), ['10', '10', '20', '20']);
  assert.deepEqual(columnNumbers(3, { initial: 254, step: 1, format: 'hex', upperHex: true }), ['FE', 'FF', '100']);
  assert.deepEqual(columnNumbers(3, { initial: 8, step: 1, format: 'bin', pad: 'zeros' }), ['1000', '1001', '1010']);
  assert.deepEqual(columnNumbers(3, { initial: 8, step: 1, format: 'oct' }), ['10', '11', '12']);
  assert.deepEqual(columnNumbers(3, { initial: 9, step: 1, pad: 'spaces' }), [' 9', '10', '11']);
  assert.deepEqual(columnNumbers(3, { initial: 1, step: -1 }), ['1', '0', '-1']);
});

test('column insert pads short lines so the column lines up', () => {
  const lines = ['interface Gi1/0/', 'ab', 'interface Gi1/0/'];
  assert.deepEqual(columnInsert(lines, 16, ['1', '2', '3']), ['interface Gi1/0/1', 'ab              2', 'interface Gi1/0/3']);
  assert.deepEqual(columnInsert(['abc', 'def'], 1, ['-']), ['a-bc', 'd-ef']);
});

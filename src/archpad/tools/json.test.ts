/** JSON tools, and the JSON/YAML round trip through the toolkit's own reader and writer. */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import { formatJson, jsonToCsv, jsonToYaml, minifyJson, sortJsonKeys, validateJson, yamlToJson } from './json.ts';

describe('format and minify', () => {
  it('indents with 2, 4 or tabs and minifies', () => {
    const src = '{"a":1,"b":[1,2]}';
    expect(formatJson(src, 2)).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(formatJson(src, 4).split('\n')[1]).toBe('    "a": 1,');
    expect(formatJson(src, '\t').split('\n')[1]).toBe('\t"a": 1,');
    expect(minifyJson('{ "a" : 1,\n "b" : [ 1 , 2 ] }')).toBe(src);
  });
});

describe('validateJson', () => {
  it('passes valid JSON', () => {
    expect(validateJson('{"a": [1, 2, {"b": null}]}')).toBeNull();
  });

  it('reports the line and column of the error', () => {
    const p = validateJson('{\n  "a": 1,\n  "b" 2\n}');
    expect(p).not.toBeNull();
    expect(p!.line).toBe(3);
    expect(p!.column).toBe(7);
  });

  it('reports an unexpected end at the end', () => {
    const p = validateJson('{\n  "a": [1, 2');
    expect(p!.line).toBe(2);
  });

  it('puts the position in the thrown message', () => {
    expect(() => formatJson('{\n"a":}')).toThrow(/Line 2, column/);
  });
});

describe('sortJsonKeys', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(sortJsonKeys('{"b":1,"a":{"d":[3,1],"c":2}}', 2)).toBe(JSON.stringify({ a: { c: 2, d: [3, 1] }, b: 1 }, null, 2));
  });
});

describe('JSON and YAML', () => {
  const data = {
    name: 'web',
    enabled: true,
    count: 3,
    mode: '0644',
    answer: 'no',
    version: '1.10',
    nothing: null,
    tags: ['a', 'b: c', ''],
    nested: { list: [{ x: 1 }, { y: 'multi\nline\n' }], empty: [], obj: {} },
  };

  it('round-trips JSON through YAML without changing a value', () => {
    const yaml = jsonToYaml(JSON.stringify(data));
    expect(yaml.startsWith('---\n')).toBe(true);
    expect(JSON.parse(yamlToJson(yaml))).toEqual(data);
  });

  it('reads YAML 1.1 as Ansible does, and multiple documents as an array', () => {
    expect(JSON.parse(yamlToJson('a: yes\nb: 0644\nc: [1, 2]\n'))).toEqual({ a: true, b: '0644', c: [1, 2] });
    expect(JSON.parse(yamlToJson('a: 1\n---\nb: 2\n'))).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('jsonToCsv', () => {
  it('flattens objects to dotted columns in first-seen order and quotes where needed', () => {
    const csv = jsonToCsv('[{"name":"a","net":{"ip":"10.0.0.1"}},{"name":"b, c","tags":["x"],"net":{"ip":"10.0.0.2"}}]');
    expect(csv).toBe('name,net.ip,tags\na,10.0.0.1,\n"b, c",10.0.0.2,"[""x""]"\n');
  });

  it('refuses an empty array', () => {
    expect(() => jsonToCsv('[]')).toThrow(/empty/);
  });
});

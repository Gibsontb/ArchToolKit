import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { renderYaml, needsQuoting, quoteScalar } from './yaml.ts';

/**
 * The quoting rules are the only subtle part of the writer, and every one of
 * them exists because an unquoted value parses as the wrong type rather than
 * failing. These tests name the real-world value each rule protects.
 */
describe('ansible/yaml: quoting', () => {
  it('quotes the YAML 1.1 booleans that look like words', () => {
    // Ansible still reads YAML 1.1, where these eleven scalars are booleans.
    for (const word of ['y', 'Y', 'yes', 'No', 'n', 'ON', 'off', 'TRUE', 'false']) {
      expect(needsQuoting(word)).toBe(true);
    }
  });

  it('quotes a country code that happens to be Norway', () => {
    // The canonical failure: country: no becomes country: false.
    expect(renderYaml({ country: 'no' })).toContain("country: 'no'");
  });

  it('quotes null-like scalars', () => {
    for (const word of ['null', 'NULL', 'none', '~']) {
      expect(needsQuoting(word)).toBe(true);
    }
  });

  it('quotes version strings so a trailing zero survives', () => {
    // 1.10 unquoted is a float and parses as 1.1.
    expect(renderYaml({ version: '1.10' })).toContain("version: '1.10'");
    expect(renderYaml({ version: '2.17.1' })).toContain('version: 2.17.1');
  });

  it('quotes anything that parses as a number of any flavour', () => {
    expect(needsQuoting('0755')).toBe(true); // octal file mode
    expect(needsQuoting('0x1F')).toBe(true); // hex
    expect(needsQuoting('1:30')).toBe(true); // sexagesimal
    expect(needsQuoting('1e5')).toBe(true);
    expect(needsQuoting('-42')).toBe(true);
    expect(needsQuoting('1_000')).toBe(true);
  });

  it('quotes leading indicators that would change the line', () => {
    for (const value of ['- item', '? key', '*anchor', '&anchor', '!tag', '#not-a-comment', '@at', '%directive']) {
      expect(needsQuoting(value)).toBe(true);
    }
  });

  it('quotes a colon-space, which would otherwise start a nested mapping', () => {
    expect(needsQuoting('Ready: yes')).toBe(true);
    expect(needsQuoting('trailing:')).toBe(true);
    // A colon with no space after it is legal inside a plain scalar.
    expect(needsQuoting('10.0.0.1:443')).toBe(false);
  });

  it('quotes a space-hash, which would otherwise start a comment', () => {
    expect(needsQuoting('cluster #1')).toBe(true);
  });

  it('quotes empty and whitespace-padded strings', () => {
    expect(needsQuoting('')).toBe(true);
    expect(needsQuoting(' padded')).toBe(true);
    expect(needsQuoting('trailing ')).toBe(true);
  });

  it('leaves ordinary values alone', () => {
    for (const value of ['esxi-01', 'vcf/mgmt', 'us-east-1', 'Managed by ArchToolKit']) {
      expect(needsQuoting(value)).toBe(false);
    }
  });

  it('escapes a single quote by doubling it, as YAML requires', () => {
    expect(quoteScalar("it's")).toBe("'it''s'");
  });
});

describe('ansible/yaml: structure', () => {
  it('writes a document marker', () => {
    expect(renderYaml({ a: 1 }).startsWith('---\n')).toBe(true);
  });

  it('ends with exactly one newline', () => {
    const out = renderYaml({ a: 1 });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('writes header comments above the marker', () => {
    const out = renderYaml({ a: 1 }, { header: 'Generated\nDo not edit' });
    expect(out.split('\n').slice(0, 3)).toEqual(['# Generated', '# Do not edit', '---']);
  });

  it('puts a sequence at its parent key indent, as ansible-lint expects', () => {
    const out = renderYaml({ tasks: [{ name: 'one' }] });
    expect(out).toContain('tasks:\n- name: one');
  });

  it('indents the continuation of a mapping inside a sequence under the dash', () => {
    const out = renderYaml([{ name: 'ping', 'ansible.builtin.ping': {} }]);
    expect(out).toContain('- name: ping\n  ansible.builtin.ping: {}');
  });

  it('nests mappings two spaces deep', () => {
    const out = renderYaml({ vars: { region: 'us-east-1', count: 3 } });
    expect(out).toContain('vars:\n  region: us-east-1\n  count: 3');
  });

  it('renders empty collections inline rather than as a dangling key', () => {
    const out = renderYaml({ a: [], b: {} });
    expect(out).toContain('a: []');
    expect(out).toContain('b: {}');
  });

  it('drops undefined entries so optional fields can be passed straight through', () => {
    const out = renderYaml({ name: 'x', when: undefined, tags: ['a'] });
    expect(out).toContain('name: x');
    expect(out).not.toContain('when');
  });

  it('keeps null distinct from absent', () => {
    expect(renderYaml({ value: null })).toContain('value: null');
  });

  it('writes booleans and numbers unquoted', () => {
    const out = renderYaml({ gather_facts: false, forks: 10, ratio: 1.5 });
    expect(out).toContain('gather_facts: false');
    expect(out).toContain('forks: 10');
    expect(out).toContain('ratio: 1.5');
  });

  it('uses a block scalar for multi-line text rather than escaping it', () => {
    const out = renderYaml({ script: 'line one\nline two' });
    expect(out).toContain('script: |-\n  line one\n  line two');
  });

  it('quotes a key that would otherwise be read as something else', () => {
    expect(renderYaml({ yes: 1 })).toContain("'yes': 1");
  });

  it('round-trips a realistic task through a nested sequence of mappings', () => {
    const out = renderYaml([
      {
        name: 'Gather VM facts',
        hosts: 'localhost',
        gather_facts: false,
        tasks: [
          {
            name: 'List virtual machines',
            'vmware.vmware.vm_info': { hostname: '{{ vcenter_hostname }}', validate_certs: false },
            register: 'vm_facts',
          },
        ],
      },
    ]);
    expect(out).toContain('- name: Gather VM facts');
    expect(out).toContain('  tasks:\n  - name: List virtual machines');
    expect(out).toContain('    vmware.vmware.vm_info:\n      hostname: ');
    // A Jinja expression starts with a brace, which is a flow-mapping indicator.
    expect(out).toContain("hostname: '{{ vcenter_hostname }}'");
    expect(out).toContain('      validate_certs: false');
  });
});

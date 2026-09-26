/**
 * The conf reader and the spec matching behind tools/validate-splunk-blueprints.mjs.
 *
 * Splunk reads a conf file without complaint when a setting is misspelt, in
 * the wrong stanza or set twice, so the checker has to be right about what
 * splunkd would accept: a continuation line is part of the value, a comment
 * is nothing, `<name>` in a spec matches whatever the operator chose, and a
 * setting outside its stanza is ignored.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { checkAgainstSpec, compileSpec, confTypeOf, credentialProblems, keyRegex, mergeSpecs, parseConf, parseSpec, stanzaRegex } from './conf-check.ts';
import { SPLUNK_CONF_SPECS, SPLUNK_SPEC_SOURCE } from './conf-spec-data.ts';
import { oneLevelDown } from './blueprints/forwarder.ts';
import { SPLUNK_APPS } from './blueprints/index.ts';
import { defaultValues } from '../kit/blueprint.ts';

const messages = (list: readonly { message: string }[]) => list.map((p) => p.message);

describe('splunk conf: reading a file', () => {
  it('reads stanzas and settings, and skips comments and blank lines', () => {
    const conf = parseConf(['# header', '', '[monitor:///var/log]', '  # indented comment', 'index = os', 'sourcetype=linux'].join('\n'));
    expect(conf.problems).toEqual([]);
    expect(conf.stanzas.map((s) => s.name)).toEqual([null, 'monitor:///var/log']);
    expect(conf.stanzas[1].settings.map((s) => [s.key, s.value, s.line])).toEqual([
      ['index', 'os', 5],
      ['sourcetype', 'linux', 6],
    ]);
  });

  it('folds a continuation line into the value, whatever it holds', () => {
    const conf = parseConf(['[Failed logins]', 'search = index=main \\', '    | stats count \\', '    # not a comment here', 'enableSched = 1'].join('\n'));
    expect(conf.problems).toEqual([]);
    const settings = conf.stanzas[1].settings;
    expect(settings.map((s) => s.key)).toEqual(['search', 'enableSched']);
    expect(settings[0].value).toBe('index=main \n| stats count \n# not a comment here');
    expect(settings[1].line).toBe(5);
  });

  it('keeps an = inside the value', () => {
    const conf = parseConf('[x]\nREGEX = ^(?<k>\\w+)=(?<v>\\S+)\n');
    expect(conf.stanzas[1].settings[0]).toEqual({ key: 'REGEX', value: '^(?<k>\\w+)=(?<v>\\S+)', line: 2 });
  });

  it('reports a key set twice in one stanza, but not in two', () => {
    const conf = parseConf(['[a]', 'index = one', '[b]', 'index = two', '[a]', 'index = three'].join('\n'));
    expect(messages(conf.problems)).toEqual([
      'stanza [a] appears twice (first on line 1); splunkd merges them',
      'index is set twice in [a] (first on line 2); only the last one counts',
    ]);
  });

  it('reports a key twice outside any stanza, and a line that is nothing', () => {
    const conf = parseConf(['host = a', 'host = b', '[s]', 'just words', '[broken', '= value'].join('\n'));
    expect(messages(conf.problems)).toEqual([
      'host is set twice outside any stanza (first on line 1); only the last one counts',
      'not a stanza, a setting or a comment: just words',
      'stanza header has no closing bracket: [broken',
      'setting with no key: = value',
    ]);
  });
});

const SPEC = [
  '# GLOBAL SETTINGS',
  'host = <string>',
  '* The host.',
  'Example 1:  LINE_BREAKER = ([\\r\\n]+)',
  '',
  '[default]',
  'index = <string>',
  '',
  '[monitor://<path>]',
  'recursive = <boolean>',
  '* Indented prose = is not a setting.',
  '',
  '[splunktcp://[<remote server>]:<port>]',
  'compressed = <boolean>',
  '',
  '[<spec>]',
  'EXTRACT-<class> = <regex>',
  'remote.* = <string>',
  '',
  '[clustering]',
  'mode = [manager|peer|searchhead]',
  '',
  '[lmpool:*]',
  'quota = <integer>',
].join('\n');

describe('splunk conf: reading a spec file', () => {
  it('collects global settings, [default] settings and each stanza’s own', () => {
    const spec = parseSpec(SPEC);
    expect(spec.global).toEqual(['host', 'index']);
    expect(spec.stanzas.map((s) => s.pattern)).toEqual(['monitor://<path>', 'splunktcp://[<remote server>]:<port>', '<spec>', 'clustering', 'lmpool:*']);
    expect(spec.stanzas[0].keys).toEqual(['recursive']);
    expect(spec.stanzas[2].keys).toEqual(['EXTRACT-<class>', 'remote.*']);
  });

  it('merges an app’s own spec into Splunk’s', () => {
    const merged = mergeSpecs(parseSpec(SPEC), parseSpec('[org_api_poll://<name>]\nendpoint = <string>\n[clustering]\nextra = <string>'));
    expect(merged.stanzas.find((s) => s.pattern === 'clustering')?.keys).toEqual(['extra', 'mode']);
    expect(merged.stanzas.some((s) => s.pattern === 'org_api_poll://<name>')).toBe(true);
  });
});

describe('splunk conf: matching stanzas and settings', () => {
  it('turns <placeholders>, * and optional brackets into stanza patterns', () => {
    expect(stanzaRegex('monitor://<path>').test('monitor:///var/log/*.log')).toBe(true);
    expect(stanzaRegex('tcp://<remote server>:<port>').test('tcp://:514')).toBe(true);
    expect(stanzaRegex('splunktcp://[<remote server>]:<port>').test('splunktcp://:9997')).toBe(true);
    expect(stanzaRegex('splunktcp://[<remote server>]:<port>').test('splunktcp://[2001:db8::1]:9997')).toBe(true);
    expect(stanzaRegex('lmpool:*').test('lmpool:prod')).toBe(true);
    expect(stanzaRegex('clustering').test('clustering2')).toBe(false);
  });

  it('turns <placeholders> and * into setting patterns that need something there', () => {
    expect(keyRegex('EXTRACT-<class>').test('EXTRACT-user')).toBe(true);
    expect(keyRegex('EXTRACT-<class>').test('EXTRACT-')).toBe(false);
    expect(keyRegex('remote.*').test('remote.s3.endpoint')).toBe(true);
    expect(keyRegex('action.<action_name>.<parameter>').test('action.email.to')).toBe(true);
  });

  it('accepts a setting its stanza has, and one that is global', () => {
    const conf = parseConf(['[monitor:///var/log]', 'recursive = true', 'host = web01', 'index = os', '[clustering]', 'mode = manager'].join('\n'));
    expect(checkAgainstSpec(conf, compileSpec(parseSpec(SPEC)), 'inputs.conf')).toEqual([]);
  });

  it('rejects a setting from another stanza type, and an unknown stanza', () => {
    const conf = parseConf(['[monitor:///var/log]', 'compressed = true', 'recursve = true', '[general]', 'x = 1'].join('\n'));
    // [<spec>] matches every stanza, so a spec with a catch-all never has an unknown one: take it out.
    const spec = parseSpec(SPEC.replace(/\[<spec>\][\s\S]*?\n\n/, ''));
    expect(messages(checkAgainstSpec(conf, compileSpec(spec), 'test.conf'))).toEqual([
      'compressed is not a setting in [monitor:///var/log] of test.conf',
      'recursve is not a setting in [monitor:///var/log] of test.conf',
      '[general] is not a stanza test.conf has',
    ]);
  });

  it('accepts settings with a pattern under a catch-all stanza, in any stanza', () => {
    const conf = parseConf(['[acme:widget]', 'EXTRACT-user = user=(?<user>\\S+)', 'remote.path = x', 'EXTRACTS-user = y'].join('\n'));
    expect(messages(checkAgainstSpec(conf, compileSpec(parseSpec(SPEC)), 'props.conf'))).toEqual(['EXTRACTS-user is not a setting in [acme:widget] of props.conf']);
  });

  it('accepts a setting outside a stanza only where splunkd applies it', () => {
    const conf = parseConf(['host = web01', 'EXTRACT-a = b', 'mode = manager', '[default]', 'quota = 5', 'index = os'].join('\n'));
    expect(messages(checkAgainstSpec(conf, compileSpec(parseSpec(SPEC)), 'server.conf'))).toEqual([
      'mode outside any stanza is only a setting of [clustering] in server.conf; here it is ignored',
      'quota in [default] is only a setting of [lmpool:*] in server.conf; here it is ignored',
    ]);
  });

  it('takes any stanza when the spec names its stanzas only in prose', () => {
    const spec = compileSpec(parseSpec('homePath = <path>\nfrozenTimePeriodInSecs = <integer>'));
    expect(messages(checkAgainstSpec(parseConf('[app_prod]\nhomePath = $SPLUNK_DB/app_prod/db\nhomepath = x'), spec, 'indexes.conf'))).toEqual(['homepath is not a setting in [app_prod] of indexes.conf']);
  });
});

describe('splunk conf: which spec a file is', () => {
  const known = new Set(['server.conf', 'inputs.conf']);
  it('goes by the file name, or the conf file its comments name', () => {
    expect(confTypeOf('app/default/inputs.conf', '', known)).toBe('inputs.conf');
    expect(confTypeOf('app/metadata/default.meta', '', known)).toBe('default.meta');
    expect(confTypeOf('app/server-conf/cluster-manager.conf', '# Review.\n# $SPLUNK_HOME/etc/system/local/server.conf on the manager\n[clustering]', known)).toBe('server.conf');
    expect(confTypeOf('app/ops/other.conf', '[x]\nkey = server.conf', known)).toBeNull();
  });
});

describe('splunk conf: credentials', () => {
  it('lets through empty values, placeholders and references', () => {
    const text = ['pass4SymmKey = <REQUIRED: set on the host>', 'token =', 'sslPassword = $7$abc', 'remote.azure.access_key = acmestorage', 'password = <set in local/>'].join('\n');
    expect(credentialProblems('app/default/server.conf', text)).toEqual([]);
  });

  it('catches a literal secret setting, a private key, a HEC token and -auth', () => {
    const text = [
      'pass4SymmKey = changeme',
      '-----BEGIN RSA PRIVATE KEY-----',
      'token = 6f1c4b5e-2a3d-4c7e-9f00-1234567890ab',
      'splunk list user -auth admin:changeme',
      'curl https://admin:hunter22@sh01.example.com:8089/services',
    ].join('\n');
    expect(messages(credentialProblems('app/default/inputs.conf', text))).toEqual([
      'pass4SymmKey is set to a literal value',
      'a private key',
      'token is set to a literal value',
      'a HEC token',
      '-auth with a literal password',
      'a URL with a password in it',
    ]);
    expect(credentialProblems('app/bin/x.sh', 'splunk login -auth "admin:$PASS"')).toEqual([]);
    expect(messages(credentialProblems('app/bin/x.py', 'password = "hunter22"'))).toEqual(['a quoted literal password or secret']);
  });
});

describe('splunk conf: the cached spec data', () => {
  it('comes from a Splunk Enterprise release and has the conf files the page writes', () => {
    expect(/^\d+\.\d+/.test(SPLUNK_SPEC_SOURCE.release)).toBe(true);
    for (const name of ['inputs.conf', 'outputs.conf', 'props.conf', 'transforms.conf', 'indexes.conf', 'server.conf', 'savedsearches.conf', 'app.conf', 'default.meta']) {
      expect([name, Boolean(SPLUNK_CONF_SPECS[name])]).toEqual([name, true]);
    }
    const inputs = compileSpec(SPLUNK_CONF_SPECS['inputs.conf']);
    expect(checkAgainstSpec(parseConf('[monitor:///var/log/messages]\nindex = os\nrecursive = false\n[http://app]\ntoken =\nuseACK = 1'), inputs, 'inputs.conf')).toEqual([]);
    expect(messages(checkAgainstSpec(parseConf('[tcp://5514]\nno_priority_stripping = true'), inputs, 'inputs.conf'))).toEqual(['no_priority_stripping is not a setting in [tcp://5514] of inputs.conf']);
  });
});

describe('splunk: what the validator found', () => {
  it('bounds a monitor input to one level of subdirectories with an allow list, not host_segment', () => {
    expect(oneLevelDown('/var/log/app/*.log')).toEqual({ path: '/var/log/app', whitelist: '^/var/log/app/(?:[^/]+/)?[^/]*\\.log$' });
    expect(oneLevelDown('/var/log/app')).toEqual({ path: '/var/log/app', whitelist: '^/var/log/app/(?:[^/]+/)?[^/]+$' });
    expect(oneLevelDown('/var/log/app/archive/...')).toBeNull();
    expect(oneLevelDown('/var/*/app.log')).toBeNull();
    const blueprint = SPLUNK_APPS.find((b) => b.id === 'splunk_file_input')!;
    const inputs = blueprint.build(defaultValues(blueprint), 'x').files['org_inputs_app/default/inputs.conf'] ?? '';
    expect(inputs.includes('host_segment = 0')).toBe(false);
    expect(parseConf(inputs).problems).toEqual([]);
  });
});

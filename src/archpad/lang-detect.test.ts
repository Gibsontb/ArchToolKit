import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFromContent, detectLanguage, languageLabel, LANGUAGES } from './lang-detect.ts';
import { eventToShortcut, normalizeShortcut, displayShortcut } from './shortcuts.ts';
import { StringStream } from '../vendor/archpad-editor.js';
import { ciscoMode, hclMode, iniMode, junosMode, logMode, type Mode } from './modes.ts';

test('extensions and file names', () => {
  assert.equal(detectLanguage('main.tf', ''), 'hcl');
  assert.equal(detectLanguage('app.PY', ''), 'python');
  assert.equal(detectLanguage('C:\\src\\Dockerfile', ''), 'dockerfile');
  assert.equal(detectLanguage('Dockerfile.prod', ''), 'dockerfile');
  assert.equal(detectLanguage('CMakeLists.txt', ''), 'cmake');
  assert.equal(detectLanguage('deploy.ps1', ''), 'powershell');
  assert.equal(detectLanguage('site.yml', ''), 'yaml');
  assert.equal(detectLanguage('syslog.log', ''), 'log');
  assert.equal(detectLanguage('/etc/nginx/nginx.conf', ''), 'nginx');
  assert.equal(detectLanguage('notes.txt', 'just words'), 'text');
  assert.equal(detectLanguage('', ''), 'text');
});

test('shebangs', () => {
  assert.equal(detectLanguage('run', '#!/usr/bin/env python3\nprint(1)'), 'python');
  assert.equal(detectLanguage('run', '#!/bin/bash\necho hi'), 'shell');
  assert.equal(detectLanguage('run', '#!/usr/bin/env node\n'), 'javascript');
  assert.equal(detectLanguage('run', '#!/usr/bin/env pwsh\n'), 'powershell');
});

test('a Cisco config saved as .txt is Cisco', () => {
  const ios = ['!', 'version 15.2', 'hostname core-sw1', '!', 'interface GigabitEthernet0/1', ' description uplink', ' ip address 10.0.0.1 255.255.255.0', '!', 'router ospf 1', ' network 10.0.0.0 0.0.0.255 area 0', 'end'].join('\n');
  assert.equal(detectLanguage('core-sw1.txt', ios), 'cisco');
  const nxos = ['feature lacp', 'feature vpc', 'hostname n9k-1', 'interface Ethernet1/1', '  switchport mode trunk'].join('\n');
  assert.equal(detectLanguage('n9k.cfg', nxos), 'cisco');
});

test('Junos in both set and brace form', () => {
  assert.equal(detectLanguage('mx.conf', 'set system host-name mx1\nset interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30\n'), 'junos');
  assert.equal(detectLanguage('srx.txt', '## Last commit: 2026-01-01\nsystem {\n    host-name srx1;\n}\ninterfaces {\n    ge-0/0/0 {\n        unit 0 {\n            family inet {\n'), 'junos');
});

test('Splunk .conf is INI, Terraform is HCL, logs are logs', () => {
  assert.equal(detectLanguage('props.conf', '[source::/var/log/*.log]\nTIME_FORMAT = %Y-%m-%d\n# comment\n'), 'ini');
  assert.equal(detectLanguage('inputs.conf', ''), 'ini');
  assert.equal(detectFromContent('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\n'), 'hcl');
  assert.equal(detectFromContent('2026-09-24 11:42:13 INFO start\n2026-09-24 11:42:14 ERROR boom\n'), 'log');
  assert.equal(detectFromContent('Sep 24 11:42:13 host sshd[1]: Accepted\nSep 24 11:42:14 host sshd[1]: closed\n'), 'log');
});

test('content fallbacks: JSON, XML, HTML, diff, YAML', () => {
  assert.equal(detectFromContent('{"a": [1, 2]}'), 'json');
  assert.equal(detectFromContent('<?xml version="1.0"?><a/>'), 'xml');
  assert.equal(detectFromContent('<!DOCTYPE html><html></html>'), 'html');
  assert.equal(detectFromContent('diff --git a/x b/x\n--- a/x\n+++ b/x\n'), 'diff');
  assert.equal(detectFromContent('---\nname: web\nhosts: all\n'), 'yaml');
  assert.equal(detectFromContent('hello there'), null);
});

test('every language has a label', () => {
  for (const l of LANGUAGES) assert.ok(languageLabel(l.id).length > 0);
  assert.equal(languageLabel('hcl'), 'Terraform / HCL');
});

test('shortcut normalisation and events', () => {
  assert.equal(normalizeShortcut('shift+ctrl+up'), 'Ctrl+Shift+Up');
  assert.equal(normalizeShortcut('Ctrl++'), 'Ctrl+=');
  assert.equal(normalizeShortcut('Ctrl+-'), 'Ctrl+-');
  assert.equal(normalizeShortcut('Alt+Shift+0'), 'Alt+Shift+0');
  assert.equal(displayShortcut('Ctrl+='), 'Ctrl++');
  const ev = (key: string, code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(eventToShortcut(ev(')', 'Digit0', { altKey: true, shiftKey: true })), 'Alt+Shift+0');
  assert.equal(eventToShortcut(ev('ArrowUp', 'ArrowUp', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Up');
  assert.equal(eventToShortcut(ev('F3', 'F3', { shiftKey: true })), 'Shift+F3');
  assert.equal(eventToShortcut(ev('s', 'KeyS', { ctrlKey: true })), 'Ctrl+S');
  assert.equal(eventToShortcut(ev('Control', 'ControlLeft', { ctrlKey: true })), '');
});

/** Run a stream mode over lines and collect [text, style] pairs. */
function tokens<S>(mode: Mode<S>, text: string): [string, string | null][] {
  const state = mode.startState();
  const out: [string, string | null][] = [];
  for (const line of text.split('\n')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = new (StringStream as any)(line, 4, 2);
    while (!stream.eol()) {
      const style = mode.token(stream, state);
      out.push([stream.current(), style]);
      assert.ok(stream.pos > stream.start, 'the tokenizer always advances');
      stream.start = stream.pos;
    }
  }
  return out.filter(([t]) => t.trim());
}

const styleOf = (list: [string, string | null][], text: string): string | null | undefined => list.find(([t]) => t.trim() === text)?.[1];

test('Cisco mode: comments, sections, interfaces, addresses', () => {
  const t = tokens(ciscoMode, '! a comment\ninterface GigabitEthernet0/1\n description uplink to core\n ip address 10.1.1.1 255.255.255.0\n ipv6 address 2001:db8::1/64\n shutdown\n permit ip any any');
  assert.equal(styleOf(t, '! a comment'), 'comment');
  assert.equal(styleOf(t, 'interface'), 'heading');
  assert.equal(styleOf(t, 'GigabitEthernet0/1'), 'typeName');
  assert.equal(styleOf(t, 'uplink to core'), 'string');
  assert.equal(styleOf(t, '10.1.1.1'), 'number');
  assert.equal(styleOf(t, '2001:db8::1/64'), 'number');
  assert.equal(styleOf(t, 'shutdown'), 'invalid');
  assert.equal(styleOf(t, 'permit'), 'atom');
});

test('Cisco mode: a multi-line banner is one string', () => {
  const t = tokens(ciscoMode, 'banner motd ^C\nAuthorised access only\n^C\nhostname r1');
  assert.equal(styleOf(t, 'Authorised access only'), 'string');
  assert.equal(styleOf(t, 'hostname'), 'heading');
});

test('Junos, INI, HCL and log modes', () => {
  const j = tokens(junosMode, 'interfaces {\n    ge-0/0/0 {\n        unit 0 { family inet { address 192.0.2.1/24; } }\n    }\n}\n/* note */ # hash');
  assert.equal(styleOf(j, 'interfaces'), 'heading');
  assert.equal(styleOf(j, 'ge-0/0/0'), 'typeName');
  assert.equal(styleOf(j, '192.0.2.1/24'), 'number');
  assert.equal(styleOf(j, '/* note */'), 'comment');

  const i = tokens(iniMode, '# splunk\n[monitor:///var/log]\nindex = main\ndisabled = false\nsearch = index=$idx$');
  assert.equal(styleOf(i, '# splunk'), 'comment');
  assert.equal(styleOf(i, '[monitor:///var/log]'), 'heading');
  assert.equal(styleOf(i, 'index'), 'propertyName');
  assert.equal(styleOf(i, 'false'), 'atom');
  assert.equal(styleOf(i, '$idx$'), 'variableName');

  const h = tokens(hclMode, 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16" # c\n  enabled = true\n  policy = <<EOF\n{ raw }\nEOF\n}');
  assert.equal(styleOf(h, 'resource'), 'keyword');
  assert.equal(styleOf(h, 'cidr_block'), 'propertyName');
  assert.equal(styleOf(h, '"10.0.0.0/16"'), 'string');
  assert.equal(styleOf(h, 'true'), 'atom');
  assert.equal(styleOf(h, '{ raw }'), 'string');

  const l = tokens(logMode, '2026-09-24T11:42:13.120Z ERROR conn from 10.0.0.5 failed\n2026-09-24 11:42:14 WARN slow\nSep 24 11:42:15 host INFO ok');
  assert.equal(styleOf(l, '2026-09-24T11:42:13.120Z'), 'meta');
  assert.equal(styleOf(l, 'ERROR'), 'invalid');
  assert.equal(styleOf(l, 'WARN'), 'annotation');
  assert.equal(styleOf(l, 'INFO'), 'labelName');
  assert.equal(styleOf(l, '10.0.0.5'), 'number');
  assert.equal(styleOf(l, 'Sep 24 11:42:15'), 'meta');
});

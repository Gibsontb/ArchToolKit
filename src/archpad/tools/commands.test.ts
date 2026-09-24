/**
 * The menu wiring: ids are unique, every command lands in Tools or Network,
 * and the text-in/text-out commands behave through a CommandContext the way
 * the core will drive them (selection first, else the whole document).
 */

import { describe, it } from 'node:test';
import { expect } from '../../testing/expect.ts';
import type { CommandContext } from '../types.ts';
import { TOOL_COMMANDS } from './index.ts';

interface Fake extends CommandContext {
  doc: string;
  sel: string;
  tabs: { name: string; text: string; language?: string }[];
  messages: { message: string; kind?: string }[];
  answers: (string | null)[];
}

function fake(doc: string, sel = '', answers: (string | null)[] = []): Fake {
  const f: Fake = {
    doc,
    sel,
    tabs: [],
    messages: [],
    answers,
    getText: () => f.doc,
    getSelection: () => f.sel,
    replaceSelection(text, options) {
      if (f.sel) {
        f.doc = f.doc.replace(f.sel, text);
        f.sel = text;
      } else if (options?.wholeWhenEmpty) f.doc = text;
      else f.doc += text;
    },
    setText: (text) => {
      f.doc = text;
    },
    newDocument: (name, text, language) => {
      f.tabs.push({ name, text, language });
    },
    notify: (message, kind) => {
      f.messages.push({ message, kind });
    },
    prompt: async () => f.answers.shift() ?? null,
    showPanel: () => undefined,
  };
  return f;
}

const run = async (id: string, ctx: Fake): Promise<Fake> => {
  const command = TOOL_COMMANDS.find((c) => c.id === id);
  if (!command) throw new Error(`no command ${id}`);
  await command.run(ctx);
  return ctx;
};

describe('TOOL_COMMANDS', () => {
  it('has unique ids and only Tools / Network menus', () => {
    const ids = TOOL_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TOOL_COMMANDS.every((c) => c.menu === 'Tools' || c.menu === 'Network')).toBe(true);
    expect(TOOL_COMMANDS.length).toBeGreaterThan(60);
  });

  it('formats the whole document, or only the selection', async () => {
    expect((await run('tools.json.format2', fake('{"a":1}'))).doc).toBe('{\n  "a": 1\n}');
    const partial = await run('tools.b64.encode', fake('x = hello;', 'hello'));
    expect(partial.doc).toBe('x = aGVsbG8=;');
  });

  it('reports failures in the status bar instead of throwing', async () => {
    const f = await run('tools.json.format2', fake('{"a":'));
    expect(f.doc).toBe('{"a":');
    expect(f.messages[0]!.kind).toBe('error');
    const v = await run('tools.json.validate', fake('{\n"a" 1}'));
    expect(v.messages[0]!.message).toContain('line 2');
  });

  it('extracts to a new tab, unique and sorted', async () => {
    const f = await run('tools.net.extract.ips', fake('b 10.0.0.10 a 10.0.0.9 c 2001:db8::1 d 10.0.0.9'));
    expect(f.tabs[0]!.text).toBe('10.0.0.9\n10.0.0.10\n2001:db8::1\n');
  });

  it('masks to a new tab and leaves the source alone', async () => {
    const src = 'username a password 7 0822455D0A16';
    const f = await run('tools.config.mask', fake(src));
    expect(f.doc).toBe(src);
    expect(f.tabs[0]!.text).toBe('username a password 7 <masked>');
  });

  it('prompts where it needs input', async () => {
    const f = await run('tools.text.wrap', fake('one two three', '', ['8']));
    expect(f.doc).toBe('one two\nthree');
    const cancelled = await run('tools.text.wrap', fake('one two three', '', [null]));
    expect(cancelled.doc).toBe('one two three');
  });
});

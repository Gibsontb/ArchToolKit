/**
 * Macro recording and playback.
 *
 * A macro is a list of steps: typed text, editing keys (arrows, Home, End,
 * Backspace, Enter, Tab… exactly the keys CodeMirror's keymap would run),
 * ArchPad commands by id, and searches. Recording listens at the edges —
 * keydown for keys, the input handler for text, the command dispatcher for
 * commands — and playback replays each through the same code path, so a
 * macro behaves the way the keystrokes did.
 */

import { defaultKeymap, historyKeymap, indentWithTab, EditorView } from '../vendor/archpad-editor.js';
import { normalizeShortcut } from './shortcuts.ts';
import type { FindOptions } from './find.ts';

export type MacroStep =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'key'; readonly k: string }
  | { readonly t: 'cmd'; readonly id: string }
  | { readonly t: 'find'; readonly o: FindOptions; readonly backward: boolean; readonly wrap: boolean }
  | { readonly t: 'replaceAll'; readonly o: FindOptions; readonly r: string };

export interface SavedMacro {
  readonly name: string;
  readonly steps: readonly MacroStep[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ViewCommand = (view: any) => boolean;

interface Binding {
  key?: string;
  win?: string;
  run?: ViewCommand;
  shift?: ViewCommand;
}

/** CodeMirror key names ("Mod-Shift-ArrowLeft") in ArchPad's form ("Ctrl+Shift+Left"). */
function fromCodeMirror(name: string): string {
  const parts = name.split(/-(?!$)/);
  const key = parts.pop()!;
  const mods = parts.map((p) => (p === 'Mod' || p === 'Ctrl' || p === 'Cmd' || p === 'Meta' ? 'Ctrl' : p));
  return normalizeShortcut([...mods, key].join('+'));
}

let keyTable: Map<string, ViewCommand> | null = null;

/** Every key CodeMirror's editing keymaps handle, for recording and replay. */
export function editingKeys(): Map<string, ViewCommand> {
  if (keyTable) return keyTable;
  keyTable = new Map();
  for (const b of [...(defaultKeymap as Binding[]), ...(historyKeymap as Binding[]), indentWithTab as Binding]) {
    const name = b.win ?? b.key;
    if (!name) continue;
    const sc = fromCodeMirror(name);
    if (b.run && !keyTable.has(sc)) keyTable.set(sc, b.run);
    if (b.shift) {
      const shifted = normalizeShortcut(`Shift+${sc}`);
      if (!keyTable.has(shifted)) keyTable.set(shifted, b.shift);
    }
  }
  return keyTable;
}

/** Replay one editing key on a view. */
export function runKey(view: unknown, shortcut: string): boolean {
  const run = editingKeys().get(shortcut);
  return run ? run(view) : false;
}

/** Records steps; merges consecutive typed characters into one text step so saved macros stay readable. */
export class MacroRecorder {
  steps: MacroStep[] = [];
  recording = false;

  start(): void {
    this.steps = [];
    this.recording = true;
  }

  stop(): MacroStep[] {
    this.recording = false;
    return this.steps;
  }

  add(step: MacroStep): void {
    if (!this.recording) return;
    const last = this.steps[this.steps.length - 1];
    if (step.t === 'text' && last?.t === 'text') this.steps[this.steps.length - 1] = { t: 'text', v: last.v + step.v };
    else this.steps.push(step);
  }

  /** An input handler that records typed text and lets CodeMirror insert it as usual. */
  inputRecorder(): unknown {
    return EditorView.inputHandler.of((_view: unknown, _from: number, _to: number, text: string) => {
      this.add({ t: 'text', v: text });
      return false;
    });
  }
}

export function describeStep(step: MacroStep): string {
  switch (step.t) {
    case 'text':
      return `Type ${JSON.stringify(step.v)}`;
    case 'key':
      return `Key ${step.k}`;
    case 'cmd':
      return `Command ${step.id}`;
    case 'find':
      return `Find ${step.backward ? 'previous' : 'next'} ${JSON.stringify(step.o.query)}`;
    case 'replaceAll':
      return `Replace all ${JSON.stringify(step.o.query)} with ${JSON.stringify(step.r)}`;
  }
}

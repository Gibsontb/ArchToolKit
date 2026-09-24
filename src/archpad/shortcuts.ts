/**
 * Notepad++-style shortcut strings ("Ctrl+Shift+Up", "Alt+0", "F3") and the
 * key events that match them.
 *
 * Events are keyed on `code` for letters and digits so Shift+0 is still "0"
 * (event.key would be ")") and a non-US layout still hits Ctrl+S.
 */

const KEY_ALIASES: Readonly<Record<string, string>> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  escape: 'Esc',
  esc: 'Esc',
  delete: 'Del',
  del: 'Del',
  insert: 'Ins',
  ins: 'Ins',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  ' ': 'Space',
  space: 'Space',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  backspace: 'Backspace',
  home: 'Home',
  end: 'End',
  plus: '=',
  '+': '=',
  equal: '=',
  minus: '-',
  subtract: '-',
  numpadadd: 'Num+',
  numpadsubtract: 'Num-',
  numpaddivide: 'Num/',
  numpadmultiply: 'Num*',
};

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]!;
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  if (key.length === 1) return key.toUpperCase();
  return key[0]!.toUpperCase() + key.slice(1);
}

/** Canonical form: modifiers in the order Ctrl, Alt, Shift, then the key ("Ctrl+Shift+Up"). */
export function normalizeShortcut(shortcut: string): string {
  // "Ctrl++" means Ctrl and the plus key.
  const parts = shortcut.replace(/\+\+$/, '+Plus').split('+').map((p) => p.trim()).filter(Boolean);
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'ctrl' || l === 'control' || l === 'cmd' || l === 'mod') ctrl = true;
    else if (l === 'alt' || l === 'option') alt = true;
    else if (l === 'shift') shift = true;
    else key = normalizeKey(p);
  }
  return [ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift', key].filter(Boolean).join('+');
}

export interface KeyLike {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey?: boolean;
}

/** The shortcut an event represents, or '' for a bare modifier press. */
export function eventToShortcut(e: KeyLike): string {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return '';
  let key: string;
  const code = e.code ?? '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Numpad\d$/.test(code)) key = code.slice(6);
  else if (code === 'Equal') key = '=';
  else if (code === 'Minus') key = '-';
  else if (code === 'NumpadAdd' || code === 'NumpadSubtract' || code === 'NumpadDivide' || code === 'NumpadMultiply') key = normalizeKey(code);
  else key = normalizeKey(e.key);
  // Cmd on a Mac keyboard behaves as Ctrl, so the shortcuts in the menus work there too.
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

/** The label a menu shows ("Ctrl+Shift+Up" stays; "Ctrl+=" becomes "Ctrl++"). */
export function displayShortcut(shortcut: string): string {
  return normalizeShortcut(shortcut).replace(/\+=$/, '++');
}

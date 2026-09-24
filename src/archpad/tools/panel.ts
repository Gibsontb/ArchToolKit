/**
 * Building blocks for the tools' result panels: a two-column table of
 * name/value rows with copy buttons, a monospaced block, a list of rows.
 * Built with el(), so values from the document are always text, never markup.
 *
 * Styles are inline and use the toolkit's tokens, so the panels look right
 * whichever stylesheet the core ships.
 */

import { el, type Child } from '../../ui/dom.ts';

const mono = 'var(--mono, ui-monospace, Consolas, monospace)';

function copyButton(value: string): HTMLButtonElement {
  const button = el('button', {
    text: 'Copy',
    attrs: { type: 'button', title: 'Copy to the clipboard' },
    style: { marginLeft: '0.5rem', fontSize: '0.75rem', padding: '0 0.4rem', cursor: 'pointer', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 4px)' },
    on: {
      click: () => {
        const done = (): void => {
          button.textContent = 'Copied';
          setTimeout(() => (button.textContent = 'Copy'), 1200);
        };
        navigator.clipboard?.writeText(value).then(done, () => (button.textContent = 'Copy failed'));
      },
    },
  });
  return button;
}

export interface Row {
  readonly name: string;
  readonly value: string;
  /** Show a copy button beside the value. */
  readonly copy?: boolean;
  /** Emphasise (for a warning such as an expired token). */
  readonly warn?: boolean;
}

export function table(rows: readonly Row[]): HTMLTableElement {
  const cell = { padding: '0.2rem 0.6rem', borderBottom: '1px solid var(--border)', verticalAlign: 'top' };
  return el(
    'table',
    { style: { borderCollapse: 'collapse', width: '100%', fontSize: '0.85rem' } },
    el(
      'tbody',
      {},
      ...rows.map((r) =>
        el(
          'tr',
          {},
          el('th', { text: r.name, style: { ...cell, textAlign: 'left', fontWeight: '600', whiteSpace: 'nowrap', color: 'var(--text-muted)' } }),
          el(
            'td',
            { style: { ...cell, fontFamily: mono, wordBreak: 'break-all', color: r.warn ? 'var(--danger)' : 'var(--text)' } },
            r.value,
            r.copy ? copyButton(r.value) : null,
          ),
        ),
      ),
    ),
  );
}

/** A grid with a header row, for matches and line reports. */
export function grid(headers: readonly string[], rows: readonly (readonly string[])[]): HTMLTableElement {
  const cell = { padding: '0.15rem 0.5rem', borderBottom: '1px solid var(--border)', verticalAlign: 'top', textAlign: 'left' };
  return el(
    'table',
    { style: { borderCollapse: 'collapse', width: '100%', fontSize: '0.85rem' } },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { text: h, style: { ...cell, color: 'var(--text-muted)', fontWeight: '600' } })))),
    el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((v) => el('td', { text: v, style: { ...cell, fontFamily: mono, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }))))),
  );
}

export function pre(text: string): HTMLPreElement {
  return el('pre', {
    text,
    style: { fontFamily: mono, fontSize: '0.85rem', margin: '0.25rem 0', padding: '0.5rem', background: 'var(--bg-sunken, transparent)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm, 4px)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '24rem', overflow: 'auto' },
  });
}

export function heading(text: string): HTMLElement {
  return el('h4', { text, style: { margin: '0.75rem 0 0.25rem', fontSize: '0.85rem', color: 'var(--text-muted)' } });
}

export function note(text: string, kind: 'info' | 'warn' = 'info'): HTMLElement {
  return el('p', { text, style: { margin: '0.25rem 0', fontSize: '0.8rem', color: kind === 'warn' ? 'var(--warn)' : 'var(--text-muted)' } });
}

export function stack(...children: Child[]): HTMLElement {
  return el('div', { class: 'archpad-tool-panel', style: { padding: '0.25rem 0.5rem' } }, ...children);
}

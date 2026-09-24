/**
 * Compare two tabs side by side (the Notepad++ Compare plugin's job), built on
 * CodeMirror's MergeView.
 *
 * Both sides stay editable. When the comparison closes, the edited text goes
 * back to the tabs it came from as ordinary, undoable changes.
 */

import { el } from '../ui/dom.ts';
import {
  MergeView,
  goToNextChunk,
  goToPreviousChunk,
  EditorView,
  EditorState,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  history,
  keymap,
  defaultKeymap,
  historyKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
} from '../vendor/archpad-editor.js';
import { archpadTheme, archpadHighlight } from './editor-ext.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface CompareSide {
  readonly name: string;
  readonly text: string;
  /** The language extension for highlighting. */
  readonly language: unknown;
}

export interface CompareSession {
  next(): void;
  previous(): void;
  /** Close the view; resolves the edited texts through onClose. */
  close(): void;
  readonly element: HTMLElement;
}

export function openCompare(
  container: HTMLElement,
  a: CompareSide,
  b: CompareSide,
  options: { readonly wrap: boolean; readonly onClose: (textA: string, textB: string) => void; readonly notify: (m: string) => void },
): CompareSession {
  const base = (language: unknown): unknown[] => [
    lineNumbers(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    archpadTheme,
    archpadHighlight,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    options.wrap ? EditorView.lineWrapping : [],
    language ?? [],
    EditorState.allowMultipleSelections.of(true),
    // The chunk list is recomputed after an edit on either side; repaint the count after it.
    EditorView.updateListener.of((u: Any) => {
      if (merge && u.docChanged) setTimeout(paintCount, 0);
    }),
  ];

  const count = el('span', { class: 'ap-compare-count' });
  const body = el('div', { class: 'ap-compare-body' });
  let closed = false;
  // eslint-disable-next-line prefer-const
  let merge: Any;
  function paintCount(): void {
    if (!merge || closed) return;
    const n = merge.chunks.length;
    count.textContent = n ? `${n} difference${n === 1 ? '' : 's'}` : 'Identical';
  }

  const move = (dir: 1 | -1): void => {
    if (!merge) return;
    const view = merge.b;
    const ok = dir > 0 ? goToNextChunk(view) : goToPreviousChunk(view);
    if (!ok) options.notify(merge.chunks.length ? 'No more differences in that direction.' : 'The two documents are identical.');
    view.focus();
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    const textA: string = merge.a.state.doc.toString();
    const textB: string = merge.b.state.doc.toString();
    merge.destroy();
    element.remove();
    options.onClose(textA, textB);
  };

  const btn = (label: string, title: string, run: () => void): HTMLButtonElement =>
    el('button', { class: 'ap-btn', text: label, attrs: { type: 'button', title }, on: { click: run } }) as HTMLButtonElement;

  const element = el(
    'div',
    { class: 'ap-compare' },
    el(
      'div',
      { class: 'ap-compare-head' },
      el('span', { class: 'ap-compare-names' }, el('strong', { text: a.name }), ' ↔ ', el('strong', { text: b.name })),
      count,
      btn('◀ Previous', 'Previous difference (Ctrl+PageUp)', () => move(-1)),
      btn('Next ▶', 'Next difference (Ctrl+PageDown)', () => move(1)),
      btn('Close compare', 'Close the comparison; edits go back to the tabs (Ctrl+Alt+X)', close),
    ),
    body,
  );
  container.appendChild(element);

  merge = new MergeView({
    a: { doc: a.text, extensions: base(a.language) },
    b: { doc: b.text, extensions: base(b.language) },
    parent: body,
    gutter: true,
    highlightChanges: true,
  });
  paintCount();
  // The first difference, so the view opens where there is something to see.
  if (merge.chunks.length) goToNextChunk(merge.b);

  return { next: () => move(1), previous: () => move(-1), close, element };
}

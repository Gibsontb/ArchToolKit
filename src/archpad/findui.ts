/**
 * Find / Replace / Find in Files / Mark: Notepad++'s search dialog, the
 * search commands behind F3 and friends, and the results panel.
 *
 * The matching itself is find.ts; this file applies it to editors and draws
 * the UI. The dialog is non-modal (you keep typing in the document while it
 * is open), remembers its options, and every action here can be recorded
 * into a macro.
 */

import { el, replace } from '../ui/dom.ts';
import { EditorSelection } from '../vendor/archpad-editor.js';
import { buildRegExp, expandReplacement, findAll, findFrom, findLines, replacementsFor, type FindOptions, type LineHit, type Replacement, type SearchMode } from './find.ts';
import { setMarks, toggleBookmark, bookmarkedLines, setBookmarks, markRanges } from './editor-ext.ts';
import { decodeFile } from './encoding.ts';
import type { MacroStep } from './macros.ts';
import type { OpenedFile } from './types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type View = any;

export interface JumpTarget {
  readonly docId?: string;
  readonly file?: OpenedFile;
  /** 1-based. */
  readonly line: number;
  readonly column: number;
  readonly length: number;
}

export interface FindHost {
  readonly root: HTMLElement;
  view(): View;
  docs(): readonly { readonly id: string; readonly name: string; readonly text: string }[];
  activeDocId(): string;
  replaceInDoc(id: string, edits: readonly Replacement[]): void;
  jump(target: JumpTarget): void;
  showPanel(title: string, body: HTMLElement): void;
  notify(message: string, kind?: 'info' | 'error'): void;
  openFolder(): Promise<{ readonly name: string; readonly files: readonly OpenedFile[] } | null>;
  openWithText(file: OpenedFile, text: string): void;
  record(step: MacroStep): void;
}

export interface SearchState {
  options: FindOptions;
  replacement: string;
  wrap: boolean;
  backward: boolean;
  inSelection: boolean;
  history: string[];
}

export const search: SearchState = {
  options: { query: '', matchCase: false, wholeWord: false, mode: 'normal', dotAll: false },
  replacement: '',
  wrap: true,
  backward: false,
  inSelection: false,
  history: [],
};

function remember(query: string): void {
  if (!query) return;
  search.history = [query, ...search.history.filter((q) => q !== query)].slice(0, 20);
}

function compile(host: FindHost, options: FindOptions): RegExp | null {
  try {
    return buildRegExp(options);
  } catch (err) {
    host.notify(`Find: ${(err as Error).message}`, 'error');
    return null;
  }
}

/** Find next/previous in the active editor and select the match. Returns false when nothing was found. */
export function findInView(host: FindHost, options: FindOptions, backward: boolean, wrap: boolean): boolean {
  const view = host.view();
  const re = compile(host, options);
  if (!view || !re) return false;
  const text: string = view.state.doc.toString();
  const sel = view.state.selection.main;
  let pos = backward ? sel.from : sel.to;
  // An empty match right at the cursor would be found forever; step past it.
  if (!backward && sel.empty) {
    const here = findFrom(text, re, pos, false, false);
    if (here && here.match.from === pos && here.match.to === pos) pos = Math.min(text.length, pos + 1);
  }
  const hit = findFrom(text, re, pos, backward, wrap);
  if (!hit) {
    host.notify(`Find: can't find "${options.query}"`, 'error');
    return false;
  }
  view.dispatch({ selection: EditorSelection.single(hit.match.from, hit.match.to), scrollIntoView: true, userEvent: 'select.search' });
  host.notify(hit.wrapped ? `Find: reached the ${backward ? 'start' : 'end'} of the document, continued from the ${backward ? 'end' : 'start'}` : '');
  return true;
}

/** Replace the current match (when the selection is one) and move to the next. */
export function replaceInView(host: FindHost, options: FindOptions, replacement: string, backward: boolean, wrap: boolean): void {
  const view = host.view();
  const re = compile(host, options);
  if (!view || !re) return;
  const sel = view.state.selection.main;
  const text: string = view.state.doc.toString();
  const match = findAll(text, re, sel.from, sel.to).find((m) => m.from === sel.from && m.to === sel.to);
  if (match && !sel.empty) {
    const insert = expandReplacement(replacement, match, options.mode);
    view.dispatch({ changes: { from: match.from, to: match.to, insert }, selection: { anchor: backward ? match.from : match.from + insert.length }, userEvent: 'input.replace' });
  }
  findInView(host, options, backward, wrap);
}

export function replaceAllInView(host: FindHost, options: FindOptions, replacement: string, inSelection: boolean): number {
  const view = host.view();
  if (!view || !compile(host, options)) return 0;
  const text: string = view.state.doc.toString();
  const sel = view.state.selection.main;
  const [from, to] = inSelection && !sel.empty ? [sel.from, sel.to] : [0, text.length];
  const edits = replacementsFor(text, options, replacement, from, to);
  if (edits.length) view.dispatch({ changes: edits, userEvent: 'input.replace' });
  host.notify(`Replace All: ${edits.length} occurrence${edits.length === 1 ? ' was' : 's were'} replaced`);
  return edits.length;
}

export function countInView(host: FindHost, options: FindOptions, inSelection: boolean): number {
  const view = host.view();
  const re = compile(host, options);
  if (!view || !re) return 0;
  const text: string = view.state.doc.toString();
  const sel = view.state.selection.main;
  const n = inSelection && !sel.empty ? findAll(text, re, sel.from, sel.to).length : findAll(text, re).length;
  host.notify(`Count: ${n} match${n === 1 ? '' : 'es'}`);
  return n;
}

export function markAllInView(host: FindHost, options: FindOptions, bookmark: boolean, purge: boolean, inSelection: boolean): number {
  const view = host.view();
  const re = compile(host, options);
  if (!view || !re) return 0;
  const text: string = view.state.doc.toString();
  const sel = view.state.selection.main;
  const matches = inSelection && !sel.empty ? findAll(text, re, sel.from, sel.to) : findAll(text, re);
  const effects: unknown[] = [];
  const previous = purge ? [] : markedRanges(view);
  effects.push(setMarks.of([...previous, ...matches.map((m) => ({ from: m.from, to: m.to }))]));
  if (bookmark) {
    const lines = new Set<number>(purge ? [] : bookmarkedLines(view.state).map((n: number) => view.state.doc.line(n).from));
    for (const m of matches) lines.add(view.state.doc.lineAt(m.from).from);
    effects.push(setBookmarks.of([...lines]));
  }
  view.dispatch({ effects });
  host.notify(`Mark: ${matches.length} match${matches.length === 1 ? '' : 'es'}`);
  return matches.length;
}

function markedRanges(view: View): { from: number; to: number }[] {
  return markRanges(view.state);
}

export function clearMarks(view: View): void {
  view?.dispatch({ effects: setMarks.of([]) });
}

// ---- Results panel ------------------------------------------------------

interface ResultGroup {
  readonly label: string;
  readonly hits: readonly LineHit[];
  readonly target: (hit: LineHit) => JumpTarget;
}

function hitRow(host: FindHost, hit: LineHit, target: JumpTarget): HTMLElement {
  const start = Math.max(0, hit.column - 60);
  const text = hit.lineText;
  const matchEnd = Math.min(text.length, hit.column + (hit.to - hit.from));
  const row = el(
    'div',
    { class: 'ap-hit', attrs: { tabindex: 0, role: 'button', title: 'Go to this line' } },
    el('span', { class: 'ap-hit-line', text: `Line ${hit.line}:` }),
    el('span', { class: 'ap-hit-text' }, (start > 0 ? '…' : '') + text.slice(start, hit.column), el('mark', { text: text.slice(hit.column, matchEnd) }), text.slice(matchEnd, matchEnd + 200)),
  );
  const go = (): void => {
    row.parentElement?.parentElement?.querySelectorAll('.ap-hit.is-current').forEach((r) => r.classList.remove('is-current'));
    row.classList.add('is-current');
    host.jump(target);
  };
  row.addEventListener('click', go);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
  return row;
}

function showResults(host: FindHost, heading: string, groups: readonly ResultGroup[]): void {
  const total = groups.reduce((n, g) => n + g.hits.length, 0);
  const files = groups.filter((g) => g.hits.length).length;
  const body = el('div', { class: 'ap-results' });
  body.appendChild(el('div', { class: 'ap-results-head', text: `${heading} (${total} hit${total === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'})` }));
  for (const g of groups) {
    if (!g.hits.length) continue;
    const list = el('div', { class: 'ap-results-hits' });
    const head = el('div', { class: 'ap-results-file', attrs: { role: 'button', tabindex: 0 } }, el('span', { class: 'ap-twisty', text: '▾' }), `${g.label} (${g.hits.length} hit${g.hits.length === 1 ? '' : 's'})`);
    head.addEventListener('click', () => {
      list.hidden = !list.hidden;
      head.firstElementChild!.textContent = list.hidden ? '▸' : '▾';
    });
    // Rows are built in chunks so a million-hit search does not freeze the page.
    const hits = g.hits.slice(0, 5000);
    for (const hit of hits) list.appendChild(hitRow(host, hit, g.target(hit)));
    if (g.hits.length > hits.length) list.appendChild(el('div', { class: 'ap-hint', text: `…and ${g.hits.length - hits.length} more` }));
    body.append(head, list);
  }
  host.showPanel('Search results', body);
}

export function findAllInDocs(host: FindHost, options: FindOptions, all: boolean): void {
  if (!compile(host, options)) return;
  const docs = all ? host.docs() : host.docs().filter((d) => d.id === host.activeDocId());
  const groups = docs.map((d) => ({
    label: d.name,
    hits: findLines(d.text, options),
    target: (hit: LineHit): JumpTarget => ({ docId: d.id, line: hit.line, column: hit.column, length: hit.to - hit.from }),
  }));
  showResults(host, `Search "${options.query}"`, groups);
}

export function replaceAllInDocs(host: FindHost, options: FindOptions, replacement: string): void {
  if (!compile(host, options)) return;
  let total = 0;
  let files = 0;
  for (const d of host.docs()) {
    const edits = replacementsFor(d.text, options, replacement);
    if (!edits.length) continue;
    host.replaceInDoc(d.id, edits);
    total += edits.length;
    files++;
  }
  host.notify(`Replace All: ${total} occurrence${total === 1 ? '' : 's'} replaced in ${files} document${files === 1 ? '' : 's'}`);
}

/** "*.conf *.txt;*.log" -> a test on the file name. Empty or "*.*" matches everything. */
export function fileFilter(pattern: string): (name: string) => boolean {
  const parts = pattern
    .split(/[;\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length || parts.includes('*.*') || parts.includes('*')) return () => true;
  const include = parts.filter((p) => !p.startsWith('!'));
  const exclude = parts.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const toRe = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  const inc = include.map(toRe);
  const exc = exclude.map(toRe);
  return (name) => {
    const base = name.split(/[\\/]/).pop() ?? name;
    return (inc.length === 0 || inc.some((r) => r.test(base))) && !exc.some((r) => r.test(base));
  };
}

let lastFolder: { readonly name: string; readonly files: readonly OpenedFile[] } | null = null;

async function findInFiles(host: FindHost, options: FindOptions, filter: string, replacement: string | null, status: (s: string, error?: boolean) => void): Promise<void> {
  if (!compile(host, options)) return;
  const folder = lastFolder ?? (await host.openFolder());
  if (!folder) {
    status('No folder chosen (or this browser cannot open folders).', true);
    return;
  }
  lastFolder = folder;
  const accept = fileFilter(filter);
  const groups: ResultGroup[] = [];
  let changedFiles = 0;
  let replaced = 0;
  for (const file of folder.files) {
    const label = file.path ?? file.name;
    if (!accept(label)) continue;
    const decoded = decodeFile(file.bytes);
    if (replacement !== null) {
      const edits = replacementsFor(decoded.text, options, replacement);
      if (!edits.length) continue;
      let out = '';
      let last = 0;
      for (const e of edits) {
        out += decoded.text.slice(last, e.from) + e.insert;
        last = e.to;
      }
      host.openWithText(file, out + decoded.text.slice(last));
      changedFiles++;
      replaced += edits.length;
      continue;
    }
    const hits = findLines(decoded.text, options);
    if (hits.length) groups.push({ label, hits, target: (hit) => ({ file, line: hit.line, column: hit.column, length: hit.to - hit.from }) });
  }
  if (replacement !== null) {
    status(`Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${changedFiles} file${changedFiles === 1 ? '' : 's'}. They are open as unsaved tabs; Save All writes them.`);
    return;
  }
  showResults(host, `Search "${options.query}" in ${folder.name}`, groups);
  status(`${groups.reduce((n, g) => n + g.hits.length, 0)} hits in ${groups.length} files (${folder.files.length} files in ${folder.name}).`);
}

// ---- The dialog ---------------------------------------------------------

export type FindTab = 'find' | 'replace' | 'files' | 'mark';

let dialog: HTMLDialogElement | null = null;
let selectTab: ((tab: FindTab) => void) | null = null;

export function openFindDialog(host: FindHost, tab: FindTab): void {
  const view = host.view();
  const selected: string = view ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) : '';
  // Seed the query with the selection when it is a single line, as Notepad++ does.
  if (selected && !selected.includes('\n') && selected.length < 500) search.options = { ...search.options, query: selected };
  if (!dialog) dialog = buildDialog(host);
  if (!dialog.open) dialog.show();
  selectTab!(tab);
}

export function closeFindDialog(): void {
  dialog?.close();
}

function buildDialog(host: FindHost): HTMLDialogElement {
  const d = el('dialog', { class: 'ap-find', attrs: { 'aria-label': 'Find' } }) as HTMLDialogElement;
  const datalist = el('datalist', { id: `ap-find-history-${Math.random().toString(36).slice(2)}` });
  const input = (placeholder: string): HTMLInputElement => el('input', { class: 'ap-input', attrs: { type: 'text', spellcheck: 'false', placeholder, list: datalist.id } }) as HTMLInputElement;
  const what = input('Find what');
  const withText = input('Replace with');
  const filters = el('input', { class: 'ap-input', attrs: { type: 'text', spellcheck: 'false', placeholder: '*.* or *.conf *.txt !*.bak' } }) as HTMLInputElement;
  filters.value = '*.*';
  const box = (label: string, checked: boolean, title?: string): HTMLInputElement => {
    const i = el('input', { attrs: { type: 'checkbox', title: title ?? null } }) as HTMLInputElement;
    i.checked = checked;
    i.dataset['label'] = label;
    return i;
  };
  const cMatchCase = box('Match case', search.options.matchCase);
  const cWhole = box('Match whole word only', search.options.wholeWord);
  const cWrap = box('Wrap around', search.wrap);
  const cSel = box('In selection', search.inSelection);
  const cBookmark = box('Bookmark line', false);
  const cPurge = box('Purge for each search', true);
  const cDotAll = box('. matches newline', !!search.options.dotAll);
  const modeRadios = (['normal', 'extended', 'regex'] as SearchMode[]).map((m) => {
    const r = el('input', { attrs: { type: 'radio', name: 'ap-find-mode', value: m } }) as HTMLInputElement;
    r.checked = search.options.mode === m;
    return r;
  });
  const dirUp = el('input', { attrs: { type: 'radio', name: 'ap-find-dir', value: 'up' } }) as HTMLInputElement;
  const dirDown = el('input', { attrs: { type: 'radio', name: 'ap-find-dir', value: 'down' } }) as HTMLInputElement;
  dirUp.checked = search.backward;
  dirDown.checked = !search.backward;
  const statusLine = el('div', { class: 'ap-find-status', attrs: { role: 'status' } });
  const status = (s: string, error = false): void => {
    statusLine.textContent = s;
    statusLine.classList.toggle('is-error', error);
  };

  const read = (): FindOptions => {
    const mode = (modeRadios.find((r) => r.checked)?.value as SearchMode) ?? 'normal';
    search.options = { query: what.value, matchCase: cMatchCase.checked, wholeWord: cWhole.checked, mode, dotAll: cDotAll.checked };
    search.replacement = withText.value;
    search.wrap = cWrap.checked;
    search.backward = dirUp.checked;
    search.inSelection = cSel.checked;
    remember(what.value);
    replace(datalist, ...search.history.map((q) => el('option', { attrs: { value: q } })));
    cDotAll.disabled = mode !== 'regex';
    return search.options;
  };
  // Messages from the search functions go to the dialog's own status line while it is open.
  const local: FindHost = {
    ...host,
    notify: (m, kind) => {
      status(m, kind === 'error');
      host.notify(m, kind);
    },
  };

  const btn = (label: string, action: () => void | Promise<void>, primary = false): HTMLButtonElement =>
    el('button', {
      class: `ap-btn${primary ? ' ap-btn-primary' : ''}`,
      text: label,
      attrs: { type: 'button' },
      on: {
        click: () => {
          status('');
          if (!what.value) {
            status('Type something to find.', true);
            what.focus();
            return;
          }
          void action();
        },
      },
    }) as HTMLButtonElement;

  const findNext = (): void => {
    const o = read();
    if (findInView(local, o, search.backward, search.wrap)) host.record({ t: 'find', o, backward: search.backward, wrap: search.wrap });
  };
  const buttons: Record<FindTab, HTMLButtonElement[]> = {
    find: [
      btn('Find Next', findNext, true),
      btn('Count', () => void countInView(local, read(), search.inSelection)),
      btn('Find All in Current Document', () => findAllInDocs(local, read(), false)),
      btn('Find All in All Opened Documents', () => findAllInDocs(local, read(), true)),
    ],
    replace: [
      btn('Find Next', findNext, true),
      btn('Replace', () => replaceInView(local, read(), search.replacement, search.backward, search.wrap)),
      btn('Replace All', () => {
        const o = read();
        replaceAllInView(local, o, search.replacement, search.inSelection);
        host.record({ t: 'replaceAll', o, r: search.replacement });
      }),
      btn('Replace All in All Opened Documents', () => replaceAllInDocs(local, read(), search.replacement)),
    ],
    files: [
      btn('Find All', () => findInFiles(local, read(), filters.value, null, status), true),
      btn('Replace in Files', () => findInFiles(local, read(), filters.value, withText.value, status)),
      el('button', {
        class: 'ap-btn',
        text: 'Choose folder…',
        attrs: { type: 'button' },
        on: {
          click: async () => {
            const f = await host.openFolder();
            if (f) {
              lastFolder = f;
              folderLabel.textContent = `${f.name} (${f.files.length} files)`;
            }
          },
        },
      }) as HTMLButtonElement,
    ],
    mark: [
      btn('Mark All', () => void markAllInView(local, read(), cBookmark.checked, cPurge.checked, search.inSelection), true),
      el('button', {
        class: 'ap-btn',
        text: 'Clear all marks',
        attrs: { type: 'button' },
        on: {
          click: () => {
            clearMarks(host.view());
            status('Marks cleared.');
          },
        },
      }) as HTMLButtonElement,
    ],
  };
  const folderLabel = el('span', { class: 'ap-hint', text: 'No folder chosen yet' });
  const label = (i: HTMLInputElement): HTMLElement => el('label', { class: 'ap-check' }, i, el('span', { text: i.dataset['label'] ?? '' }));

  const tabs: FindTab[] = ['find', 'replace', 'files', 'mark'];
  const tabNames: Record<FindTab, string> = { find: 'Find', replace: 'Replace', files: 'Find in Files', mark: 'Mark' };
  const tabBar = el('div', { class: 'ap-find-tabs', attrs: { role: 'tablist' } });
  const replaceRow = el('label', { class: 'ap-field' }, el('span', { text: 'Replace with' }), withText);
  const filterRow = el('div', { class: 'ap-field' }, el('span', { text: 'Filters' }), filters, el('span', { text: 'Folder' }), folderLabel);
  const markOpts = el('div', { class: 'ap-find-opts' }, label(cBookmark), label(cPurge));
  const buttonCol = el('div', { class: 'ap-find-buttons' });
  let current: FindTab = 'find';
  selectTab = (tab: FindTab): void => {
    current = tab;
    tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset['tab'] === tab));
    replaceRow.hidden = !(tab === 'replace' || tab === 'files');
    filterRow.hidden = tab !== 'files';
    markOpts.hidden = tab !== 'mark';
    replace(buttonCol, ...buttons[tab], el('button', { class: 'ap-btn', text: 'Close', attrs: { type: 'button' }, on: { click: () => d.close() } }));
    what.value = search.options.query;
    withText.value = search.replacement;
    what.focus();
    what.select();
    status('');
  };
  for (const tab of tabs) {
    tabBar.appendChild(el('button', { class: 'ap-find-tab', text: tabNames[tab], attrs: { type: 'button', 'data-tab': tab, role: 'tab' }, on: { click: () => selectTab!(tab) } }));
  }

  const head = el(
    'div',
    { class: 'ap-dialog-head ap-drag' },
    el('strong', { text: 'Find' }),
    el('button', { class: 'ap-x', text: '×', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => d.close() } }),
  );
  d.append(
    head,
    tabBar,
    el(
      'div',
      { class: 'ap-find-body' },
      el(
        'div',
        { class: 'ap-find-main' },
        el('label', { class: 'ap-field' }, el('span', { text: 'Find what' }), what),
        replaceRow,
        filterRow,
        el(
          'div',
          { class: 'ap-find-grid' },
          el('div', { class: 'ap-find-opts' }, label(cMatchCase), label(cWhole), label(cWrap), label(cSel)),
          el(
            'fieldset',
            { class: 'ap-find-mode' },
            el('legend', { text: 'Search Mode' }),
            el('label', { class: 'ap-check' }, modeRadios[0]!, el('span', { text: 'Normal' })),
            el('label', { class: 'ap-check' }, modeRadios[1]!, el('span', { text: 'Extended (\\n, \\r, \\t, \\0, \\x...)' })),
            el('label', { class: 'ap-check' }, modeRadios[2]!, el('span', { text: 'Regular expression' })),
            label(cDotAll),
          ),
          el('fieldset', { class: 'ap-find-mode' }, el('legend', { text: 'Direction' }), el('label', { class: 'ap-check' }, dirUp, el('span', { text: 'Up' })), el('label', { class: 'ap-check' }, dirDown, el('span', { text: 'Down' }))),
        ),
        markOpts,
      ),
      buttonCol,
    ),
    statusLine,
    datalist,
  );
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      d.close();
      host.view()?.focus();
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') {
      e.preventDefault();
      (buttons[current][0] as HTMLButtonElement).click();
    }
  });
  // Drag the dialog by its title bar.
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = d.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev: PointerEvent): void => {
      d.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
      d.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
      d.style.right = 'auto';
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  modeRadios.forEach((r) => r.addEventListener('change', () => (cDotAll.disabled = !modeRadios[2]!.checked)));
  cDotAll.disabled = !modeRadios[2]!.checked;
  host.root.appendChild(d);
  return d;
}

/** Bookmark every line with a match (the Mark tab's "Bookmark line" on its own). */
export function toggleBookmarkAtCursor(view: View): void {
  view.dispatch({ effects: toggleBookmark.of(view.state.selection.main.head) });
}

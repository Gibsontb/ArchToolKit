/**
 * Data editor: open a JSON or YAML file and change it, checked as you go.
 *
 * One page for the structured files an architect ends up editing by hand — a
 * VCF deployment spec, an Ansible playbook or inventory, Terraform JSON, a
 * CloudFormation or ARM template, an IAM policy from any of the clouds, an F5
 * AS3 or DO declaration, a Kubernetes manifest. The kind of file is detected
 * (and can be overridden); it decides which fields are dropdowns, what the
 * checks are, and what things are called.
 *
 * Two views of the same document:
 *
 *  - Form: every field as a control, lists with add / copy / move / remove,
 *    answer sets as dropdowns. Editing here rewrites the file from the data,
 *    so YAML comments do not survive it; the page says so before it happens.
 *  - Text: the file as written, with line numbers. Findings point at lines.
 *    Editing here keeps comments and formatting, and is the only view for a
 *    file with tags a form cannot carry (`!vault`).
 *
 * Nothing leaves the page. The document is kept in this tab only, so a reload
 * does not lose work. Secrets written in clear text are counted, masked in the
 * form and the change list, and can be stripped on download.
 */

import { el, append, replace, downloadFile, readFileAsText } from './dom.ts';
import { card, findingItem, stat, statGrid } from './components.ts';
import { countBySeverity, hasErrors, warning, type Finding } from '../core/findings.ts';
import { jsonLines, readYaml, YamlError, type YamlReadResult } from '../core/yaml-read.ts';
import { renderYaml, type YamlValue } from '../ansible/yaml.ts';
import {
  diff,
  findReplace,
  isRecord,
  isSecretPath,
  labelFor,
  moveAt,
  newEntry,
  parsePath,
  pathString,
  redactSecrets,
  removeAt,
  renameAt,
  secretPaths,
  setAt,
  DEFAULT_IDENTITY,
  type Json,
  type Path,
} from '../editor/doc.ts';
import { choicesAt, FAMILY_LABELS, perDocument, type Profile } from '../editor/profile.ts';
import { detectProfile, profileById, profilesByFamily, PROFILES } from '../editor/profiles/index.ts';
import { takeHandoff } from './handoff.ts';

const STORE_KEY = 'archtoolkit.data-editor';

type Format = 'json' | 'yaml';
type View = 'form' | 'text';

interface EditorState {
  name: string;
  format: Format;
  /** A YAML file with several documents: `current` is the list of them. */
  multi: boolean;
  profileId: string;
  /** The profile was chosen by detection, not by hand. */
  detected: boolean;
  original: Json;
  current: Json;
  /** The file as text. Authoritative while `textIsSource`. */
  text: string;
  /** The text was last edited by hand, so it is what gets downloaded. */
  textIsSource: boolean;
  view: View;
  comments: number;
  rewrittenTags: number;
  unsupportedTags: { tag: string; line: number }[];
}

/** What `?profile=` accepts: a profile id, or a family name for its first profile. */
function profileFromQuery(): Profile | undefined {
  const q = new URLSearchParams(globalThis.location?.search ?? '').get('profile');
  if (!q) return undefined;
  return profileById(q) ?? PROFILES.find((p) => p.family === q);
}

function saveState(state: EditorState | null): void {
  try {
    if (state) sessionStorage.setItem(STORE_KEY, JSON.stringify(state));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // A document too large for the tab store is still edited; only a reload would lose it.
  }
}

function loadState(): EditorState | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as EditorState) : null;
  } catch {
    return null;
  }
}

/** The document as text in `format`. A multi-document YAML file is written back as documents. */
export function serialize(doc: Json, format: Format, multi: boolean): string {
  if (format === 'json') return `${JSON.stringify(doc, null, 2)}\n`;
  if (multi && Array.isArray(doc)) return doc.map((d) => renderYaml(d as YamlValue)).join('');
  return renderYaml(doc as YamlValue);
}

interface Parsed {
  doc: Json;
  multi: boolean;
  lines: ReadonlyMap<string, number>;
  yaml?: YamlReadResult;
}

/** Read text as `format`; throws with a line number where it can. */
export function parseText(text: string, format: Format): Parsed {
  if (format === 'json') {
    try {
      const doc = JSON.parse(text) as Json;
      return { doc, multi: false, lines: jsonLines(text) };
    } catch (err) {
      const m = /position (\d+)/.exec((err as Error).message);
      const line = m ? text.slice(0, Number(m[1])).split('\n').length : undefined;
      throw new YamlError((err as Error).message.replace(/^JSON\.parse: /, ''), line ?? 1);
    }
  }
  const yaml = readYaml(text);
  const multi = yaml.documents.length > 1;
  return { doc: (multi ? yaml.documents : (yaml.documents[0] ?? null)) as Json, multi, lines: yaml.lines, yaml };
}

function guessFormat(name: string, text: string): Format {
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  if (/\.json$/i.test(name)) return 'json';
  return /^\s*[[{]/.test(text) ? 'json' : 'yaml';
}

/** The line a finding's path points at, or the nearest recorded parent's. */
function lineFor(lines: ReadonlyMap<string, number>, path: string | undefined): number | undefined {
  if (path === undefined) return undefined;
  let p = parsePath(path);
  for (;;) {
    const line = lines.get(pathString(p));
    if (line !== undefined) return line;
    if (p.length === 0) return undefined;
    p = p.slice(0, -1);
  }
}

export function mountDataEditorPage(root: HTMLElement): void {
  let state: EditorState | null = null;
  let lines: ReadonlyMap<string, number> = new Map();
  let parseError: { message: string; line?: number } | null = null;
  const history: { current: Json; text: string; textIsSource: boolean }[] = [];

  const tree = el('div', { class: 'je-tree' });
  const textPane = el('div', { class: 'de-text' });
  const validationBox = el('div', {});
  const changesBox = el('div', {});
  const summary = el('div', {});
  const notes = el('div', { class: 'stack' });
  const loadStatus = el('div', { class: 'field-hint' });
  const workspace = el('div', { class: 'split je-split', style: { display: 'none' } });
  const profileSelect = el('select', { attrs: { 'aria-label': 'Kind of file', 'data-control': 'profile' } }) as HTMLSelectElement;
  const formatSelect = el('select', { attrs: { 'aria-label': 'Save as', 'data-control': 'format' } }) as HTMLSelectElement;
  const viewTabs = el('div', { class: 'de-tabs', attrs: { role: 'tablist' } });

  const profile = (): Profile => profileById(state?.profileId ?? 'generic') ?? (profileById('generic') as Profile);
  const lifted = (): Profile => perDocument(profile(), state?.multi ?? false);
  const labels = (): Readonly<Record<string, string>> => profile().labels ?? {};

  // --- the text editor, with line numbers ------------------------------------
  const gutter = el('pre', { class: 'de-gutter', attrs: { 'aria-hidden': 'true' } });
  const textArea = el('textarea', {
    class: 'de-textarea',
    attrs: { spellcheck: 'false', wrap: 'off', 'aria-label': 'File text', autocapitalize: 'off', autocomplete: 'off' },
  }) as HTMLTextAreaElement;
  const textStatus = el('div', { class: 'field-hint' });
  append(textPane, el('div', { class: 'de-editor' }, gutter, textArea), textStatus);

  const renderGutter = () => {
    const count = textArea.value.split('\n').length;
    const errLine = parseError?.line;
    const findingLines = new Set<number>();
    if (state && !parseError) for (const f of findingsNow()) if (f.severity !== 'info') findingLines.add(lineFor(lines, f.path) ?? -1);
    gutter.textContent = '';
    for (let i = 1; i <= count; i += 1) {
      const n = el('span', { text: `${i}\n`, class: i === errLine ? 'de-line-error' : findingLines.has(i) ? 'de-line-finding' : '' });
      gutter.appendChild(n);
    }
  };
  textArea.addEventListener('scroll', () => {
    gutter.scrollTop = textArea.scrollTop;
  });
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  textArea.addEventListener('input', () => {
    if (!state) return;
    renderGutter();
    clearTimeout(textTimer);
    textTimer = setTimeout(() => applyText(textArea.value), 250);
  });
  // Tab indents rather than leaving the box, as in any code editor.
  textArea.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const { selectionStart: s, selectionEnd: t } = textArea;
    textArea.setRangeText('  ', s, t, 'end');
    textArea.dispatchEvent(new Event('input'));
  });

  function goToLine(line: number): void {
    const all = textArea.value.split('\n');
    let offset = 0;
    for (let i = 0; i < line - 1 && i < all.length; i += 1) offset += (all[i] as string).length + 1;
    const end = offset + (all[line - 1]?.length ?? 0);
    textArea.focus();
    textArea.setSelectionRange(offset, end);
    const lineHeight = textArea.scrollHeight / Math.max(all.length, 1);
    textArea.scrollTop = Math.max(0, (line - 5) * lineHeight);
  }

  /** Text typed in the text view: parse it, and if it reads, it is the document. */
  function applyText(text: string): void {
    if (!state) return;
    try {
      const parsed = parseText(text, state.format);
      if (JSON.stringify(parsed.doc) !== JSON.stringify(state.current) || text !== state.text) {
        history.push({ current: state.current, text: state.text, textIsSource: state.textIsSource });
        if (history.length > 200) history.shift();
      }
      state.current = parsed.doc;
      state.multi = parsed.multi;
      state.text = text;
      state.textIsSource = true;
      state.comments = parsed.yaml?.comments ?? 0;
      state.rewrittenTags = parsed.yaml?.rewrittenTags ?? 0;
      state.unsupportedTags = [...(parsed.yaml?.unsupportedTags ?? [])];
      lines = parsed.lines;
      parseError = null;
      textStatus.textContent = '';
      saveState(state);
      renderSide();
      renderGutter();
    } catch (err) {
      parseError = { message: (err as Error).message, line: err instanceof YamlError ? err.line : undefined };
      state.text = text;
      state.textIsSource = true;
      saveState(state);
      textStatus.textContent = `Not readable as ${state.format.toUpperCase()} — ${parseError.message}. The form and checks show the last version that read.`;
      renderGutter();
    }
  }

  // --- loading ---------------------------------------------------------------
  function open(name: string, source: string | Json, format?: Format, forceProfile?: Profile): void {
    const text = typeof source === 'string' ? source : JSON.stringify(source, null, 2);
    const fmt = format ?? (typeof source === 'string' ? guessFormat(name, text) : 'json');
    let parsed: Parsed;
    try {
      parsed = parseText(text, fmt);
    } catch (err) {
      loadStatus.textContent = `That does not read as ${fmt.toUpperCase()}: ${(err as Error).message}`;
      return;
    }
    const detected = detectProfile(parsed.doc, name, parsed.multi);
    const chosen = forceProfile ?? profileFromQuery();
    const unsupported = [...(parsed.yaml?.unsupportedTags ?? [])];
    state = {
      name,
      format: fmt,
      multi: parsed.multi,
      profileId: (chosen ?? detected.profile).id,
      detected: !chosen,
      original: parsed.doc,
      current: parsed.doc,
      text,
      textIsSource: true,
      view: unsupported.length ? 'text' : 'form',
      comments: parsed.yaml?.comments ?? 0,
      rewrittenTags: parsed.yaml?.rewrittenTags ?? 0,
      unsupportedTags: unsupported,
    };
    lines = parsed.lines;
    parseError = null;
    history.length = 0;
    loadStatus.textContent = '';
    workspace.style.display = '';
    saveState(state);
    renderAll();
  }

  const fileInput = el('input', {
    attrs: { type: 'file', accept: '.json,.yaml,.yml,.tfvars.json,application/json,application/yaml,text/yaml', 'data-control': 'file' },
  }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void readFileAsText(file).then((text) => open(file.name, text));
  });
  const paste = el('textarea', {
    attrs: { rows: '5', placeholder: 'Or paste JSON or YAML here…', spellcheck: 'false', 'data-control': 'paste' },
  }) as HTMLTextAreaElement;

  const kinds = profilesByFamily()
    .filter(([f]) => f !== 'generic')
    .map(([f, ps]) => `${FAMILY_LABELS[f]} (${ps.map((p) => p.label.replace(/^(AWS|Azure|Google Cloud|Oracle Cloud|F5|Ansible|Terraform) /, '')).join(', ')})`);

  const loadCard = card(
    'Open a file',
    el('p', { class: 'muted small', text: 'JSON or YAML. It is read in this page and kept in this tab only; nothing is uploaded.' }),
    el('div', { class: 'field' }, fileInput),
    el('div', { class: 'field' }, paste),
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn',
        text: 'Open pasted text',
        on: { click: () => open(guessFormat('', paste.value) === 'json' ? 'pasted.json' : 'pasted.yaml', paste.value) },
      }),
    ),
    loadStatus,
    el('details', { class: 'small muted' }, el('summary', { text: 'Files it knows' }), el('ul', {}, ...kinds.map((k) => el('li', { text: k })))),
  );

  // --- editing ---------------------------------------------------------------
  function commit(next: Json, structural: boolean): void {
    if (!state) return;
    history.push({ current: state.current, text: state.text, textIsSource: state.textIsSource });
    if (history.length > 200) history.shift();
    state.current = next;
    state.text = serialize(next, state.format, state.multi);
    state.textIsSource = false;
    // Line numbers now refer to the rewritten text.
    try {
      lines = parseText(state.text, state.format).lines;
    } catch {
      lines = new Map();
    }
    state.comments = 0;
    state.rewrittenTags = 0;
    parseError = null;
    saveState(state);
    if (structural) renderTree();
    renderSide();
  }

  function undo(): void {
    if (!state) return;
    const prev = history.pop();
    if (!prev) return;
    state.current = prev.current;
    state.text = prev.text;
    state.textIsSource = prev.textIsSource;
    try {
      const parsed = parseText(state.text, state.format);
      lines = parsed.lines;
      state.comments = parsed.yaml?.comments ?? 0;
    } catch {
      lines = new Map();
    }
    parseError = null;
    saveState(state);
    renderAll();
  }

  /** The control for one value, bound to its path. */
  function valueControl(path: Path, value: Json): HTMLElement {
    const at = pathString(path);
    const choices = state ? choicesAt(profile(), state.current, path, state.multi) : undefined;
    const setValue = (next: Json) => commit(setAt(state!.current, path, next), false);

    if (typeof value === 'boolean') {
      const s = el('select', { attrs: { 'data-path': at } }) as HTMLSelectElement;
      for (const v of ['true', 'false']) s.appendChild(el('option', { text: v, attrs: { value: v } }));
      s.value = String(value);
      s.addEventListener('change', () => setValue(s.value === 'true'));
      return s;
    }
    if (choices && (typeof value === 'string' || typeof value === 'number' || value === null)) {
      const s = el('select', { attrs: { 'data-path': at } }) as HTMLSelectElement;
      const current = value === null ? '' : String(value);
      const options = [...choices];
      if (!options.includes(current)) options.unshift(current);
      for (const v of options) s.appendChild(el('option', { text: v === '' ? '(empty)' : v, attrs: { value: v } }));
      s.appendChild(el('option', { text: 'Other…', attrs: { value: '\u0000other' } }));
      s.value = current;
      s.addEventListener('change', () => {
        if (s.value === '\u0000other') {
          // Not every file keeps to the published set; the text view is not the only way out.
          const input = el('input', { attrs: { 'data-path': at, type: 'text', spellcheck: 'false' } }) as HTMLInputElement;
          input.value = current;
          input.addEventListener('change', () => setValue(typeof value === 'number' && Number.isFinite(Number(input.value)) ? Number(input.value) : input.value));
          s.replaceWith(input);
          input.focus();
          return;
        }
        setValue(typeof value === 'number' && Number.isFinite(Number(s.value)) ? Number(s.value) : s.value);
      });
      return s;
    }
    const secret = isSecretPath(path);
    if (typeof value === 'string' && value.includes('\n')) {
      const area = el('textarea', { class: 'de-multiline', attrs: { 'data-path': at, spellcheck: 'false', rows: String(Math.min(12, value.split('\n').length + 1)) } }) as HTMLTextAreaElement;
      area.value = value;
      area.addEventListener('input', () => setValue(area.value));
      return area;
    }
    const input = el('input', {
      attrs: {
        'data-path': at,
        type: secret ? 'password' : typeof value === 'number' ? 'number' : 'text',
        spellcheck: 'false',
        autocomplete: 'off',
        ...(value === null ? { placeholder: 'null' } : {}),
      },
    }) as HTMLInputElement;
    input.value = value === null ? '' : String(value);
    input.addEventListener('input', () => {
      if (typeof value === 'number') {
        const n = Number(input.value);
        setValue(input.value.trim() === '' || !Number.isFinite(n) ? input.value : n);
      } else if (value === null && input.value === '') setValue(null);
      else setValue(input.value);
    });
    if (!secret) return input;
    const reveal = el('button', {
      class: 'btn btn-small',
      text: 'Show',
      attrs: { type: 'button' },
      on: {
        click: () => {
          input.type = input.type === 'password' ? 'text' : 'password';
          reveal.textContent = input.type === 'password' ? 'Show' : 'Hide';
        },
      },
    });
    return el('div', { class: 'je-secret' }, input, reveal);
  }

  const smallButton = (text: string, title: string, act: () => void, disabled = false) =>
    el('button', {
      class: 'btn btn-small',
      text,
      attrs: { type: 'button', title, ...(disabled ? { disabled: 'disabled' } : {}) },
      on: {
        click: (e: Event) => {
          e.preventDefault();
          act();
        },
      },
    });

  function itemButtons(path: Path, list: readonly Json[]): HTMLElement {
    const index = path[path.length - 1] as number;
    return el(
      'span',
      { class: 'je-actions' },
      smallButton('↑', 'Move up', () => commit(moveAt(state!.current, path, -1), true), index === 0),
      smallButton('↓', 'Move down', () => commit(moveAt(state!.current, path, 1), true), index === list.length - 1),
      smallButton('Copy', 'Duplicate this entry', () => {
        const parent = path.slice(0, -1);
        const copy = structuredClone(list[index]) as Json;
        commit(setAt(state!.current, parent, [...list.slice(0, index + 1), copy, ...list.slice(index + 1)]), true);
      }),
      smallButton('Remove', 'Remove this entry', () => commit(removeAt(state!.current, path), true)),
    );
  }

  /** Buttons on a field inside an object: rename it, remove it. */
  function fieldButtons(path: Path): HTMLElement {
    const key = path[path.length - 1] as string;
    return el(
      'span',
      { class: 'je-actions de-field-actions' },
      smallButton('Rename', `Rename ${key}`, () => {
        const to = globalThis.prompt?.(`New name for ${key}`, key);
        if (to && to !== key) commit(renameAt(state!.current, path, to), true);
      }),
      smallButton('×', `Remove ${key}`, () => commit(removeAt(state!.current, path), true)),
    );
  }

  /** An inline row for adding a field to an object. */
  function addFieldRow(path: Path, value: Record<string, Json>): HTMLElement {
    const name = el('input', { attrs: { type: 'text', placeholder: 'New field name', spellcheck: 'false', 'aria-label': 'New field name' } }) as HTMLInputElement;
    const kind = el('select', { attrs: { 'aria-label': 'New field type' } }) as HTMLSelectElement;
    for (const [v, t] of [['text', 'Text'], ['number', 'Number'], ['boolean', 'True / false'], ['list', 'List'], ['group', 'Group']]) {
      kind.appendChild(el('option', { text: t, attrs: { value: v as string } }));
    }
    const add = smallButton('Add field', 'Add a field here', () => {
      const key = name.value.trim();
      if (!key || key in value) {
        name.focus();
        return;
      }
      const initial: Json = { text: '', number: 0, boolean: false, list: [], group: {} }[kind.value as 'text'] as Json;
      commit(setAt(state!.current, [...path, key], initial), true);
    });
    return el('div', { class: 'de-add-field' }, name, kind, add);
  }

  function titleFor(item: Json, path: Path, index: number): string {
    const t = lifted().itemTitle?.(item, path) ?? profileById('generic')?.itemTitle?.(item, path);
    return t ? `${index + 1} · ${t}` : `${index + 1}`;
  }

  function node(path: Path, value: Json, label: string, inObject: boolean): HTMLElement {
    if (Array.isArray(value)) {
      const hasObjects = value.some((v) => v !== null && typeof v === 'object');
      const body = el('div', { class: 'je-list' });
      value.forEach((item, i) => {
        const itemPath = [...path, i];
        if (hasObjects && item !== null && typeof item === 'object') {
          append(
            body,
            el(
              'details',
              { class: 'je-item', attrs: { open: 'open', 'data-section': pathString(itemPath) } },
              el('summary', {}, el('span', { text: titleFor(item, itemPath, i) }), itemButtons(itemPath, value)),
              Array.isArray(item) ? node(itemPath, item, `Item ${i + 1}`, false) : objectBody(itemPath, item),
            ),
          );
        } else {
          append(body, el('div', { class: 'je-row' }, valueControl(itemPath, item), itemButtons(itemPath, value)));
        }
      });
      const identity = profile().identity ?? DEFAULT_IDENTITY;
      append(
        body,
        el('button', {
          class: 'btn btn-small je-add',
          text: `Add to ${label.toLowerCase()}`,
          attrs: { type: 'button', 'data-add': pathString(path) },
          on: { click: () => commit(setAt(state!.current, [...path, value.length], newEntry(value, identity)), true) },
        }),
      );
      return el(
        'div',
        { class: 'je-field je-field-block', attrs: { 'data-section': pathString(path) } },
        el('div', { class: 'de-field-head' }, el('span', { class: 'je-label', text: `${label} (${value.length})` }), inObject ? fieldButtons(path) : null),
        body,
      );
    }
    if (value !== null && typeof value === 'object') {
      return el(
        'details',
        { class: 'je-group', attrs: { open: 'open', 'data-section': pathString(path) } },
        el('summary', {}, el('span', { text: label }), inObject ? fieldButtons(path) : null),
        objectBody(path, value),
      );
    }
    return el(
      'div',
      { class: 'je-field' },
      el('label', { class: 'je-label', text: label, attrs: { title: pathString(path) } }),
      el('div', { class: 'de-value' }, valueControl(path, value), inObject ? fieldButtons(path) : null),
    );
  }

  function objectBody(path: Path, value: Json): HTMLElement {
    const body = el('div', { class: 'je-body' });
    const entries = Object.entries(value as Record<string, Json>);
    // Plain values first, then lists and groups, so a section reads as a form.
    const simple = entries.filter(([, v]) => v === null || typeof v !== 'object');
    const nested = entries.filter(([, v]) => v !== null && typeof v === 'object');
    for (const [k, v] of [...simple, ...nested]) append(body, node([...path, k], v, labelFor(k, labels()), true));
    if (entries.length === 0) append(body, el('div', { class: 'muted small', text: 'Empty.' }));
    append(body, addFieldRow(path, value as Record<string, Json>));
    return body;
  }

  /** The top of the document: sections for an object, one card per entry for a list. */
  function renderTree(): void {
    if (!state) return;
    const doc = state.current;
    if (state.unsupportedTags.length) {
      replace(
        tree,
        card(
          'Text only',
          el('p', {
            text: `This file uses ${[...new Set(state.unsupportedTags.map((t) => t.tag))].join(', ')} (line ${state.unsupportedTags.map((t) => t.line).join(', ')}). A form cannot carry that tag, so editing here would lose it; edit in the Text view, where the file stays as written.`,
          }),
        ),
      );
      return;
    }
    if (Array.isArray(doc)) {
      const cards = doc.map((item, i) => {
        const path = [i];
        const title = state!.multi ? `Document ${titleFor(item, path, i)}` : titleFor(item, path, i);
        const body = isRecord(item) ? objectBody(path, item) : Array.isArray(item) ? node(path, item, `Item ${i + 1}`, false) : node(path, item, 'Value', false);
        return el(
          'details',
          { class: 'je-section card', attrs: { 'data-section': pathString(path), ...(i < 12 ? { open: 'open' } : {}) } },
          el('summary', { class: 'card-title' }, el('span', { text: title }), itemButtons(path, doc)),
          body,
        );
      });
      const addLabel = state.multi ? 'Add a document' : 'Add an entry';
      replace(
        tree,
        ...cards,
        el('button', {
          class: 'btn btn-small je-add',
          text: addLabel,
          attrs: { type: 'button', 'data-add': '' },
          on: { click: () => commit([...doc, newEntry(doc, profile().identity ?? DEFAULT_IDENTITY)], true) },
        }),
      );
      return;
    }
    if (!isRecord(doc)) {
      replace(tree, card('Value', node([], doc, 'Value', false)));
      return;
    }
    const scalars = Object.entries(doc).filter(([, v]) => v === null || typeof v !== 'object');
    const sections = Object.entries(doc)
      .filter(([, v]) => v !== null && typeof v === 'object')
      .map(([key, value], i) =>
        el(
          'details',
          { class: 'je-section card', attrs: { 'data-section': pathString([key]), ...(i < 12 ? { open: 'open' } : {}) } },
          el('summary', { class: 'card-title' }, el('span', { text: labelFor(key, labels()) }), fieldButtons([key])),
          Array.isArray(value) ? node([key], value, labelFor(key, labels()), false) : objectBody([key], value),
        ),
      );
    replace(
      tree,
      card('Top level', ...scalars.map(([k, v]) => node([k], v, labelFor(k, labels()), true)), addFieldRow([], doc)),
      ...sections,
    );
  }

  /** Put the cursor on what a finding or a change points at, in whichever view is showing. */
  function focusPath(at: string): void {
    if (!state) return;
    if (state.view === 'text') {
      const line = lineFor(lines, at);
      if (line) goToLine(line);
      return;
    }
    let p = parsePath(at);
    let target: HTMLElement | null = null;
    while (!target) {
      const s = pathString(p);
      target = tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(s)}"]`) ?? tree.querySelector<HTMLElement>(`[data-section="${CSS.escape(s)}"]`);
      if (p.length === 0) break;
      p = p.slice(0, -1);
    }
    if (!target) return;
    for (let n: HTMLElement | null = target; n; n = n.parentElement) {
      if (n.tagName === 'DETAILS') (n as HTMLDetailsElement).open = true;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus?.();
    target.classList.add('je-flash');
    setTimeout(() => target?.classList.remove('je-flash'), 1600);
  }

  function findingsNow(): Finding[] {
    if (!state) return [];
    const out = [...(lifted().validate?.(state.current) ?? [])];
    return out;
  }

  function clickable(f: Finding): HTMLElement {
    const item = findingItem(f);
    const line = lineFor(lines, f.path);
    if (line !== undefined && state) {
      append(item, el('div', { class: 'small muted', text: `Line ${line}${f.path ? ` · ${f.path}` : ''}` }));
    }
    if (f.path !== undefined) {
      item.style.cursor = 'pointer';
      item.title = f.path ? `Go to ${f.path}` : 'Go to the top';
      item.setAttribute('data-finding', f.code);
      item.addEventListener('click', () => focusPath(f.path as string));
    }
    return item;
  }

  function renderNotes(): void {
    if (!state) return;
    const out: HTMLElement[] = [];
    if (state.view === 'form' && state.textIsSource && state.comments > 0 && state.format === 'yaml') {
      out.push(
        el('div', {
          class: 'callout callout-warn small',
          attrs: { 'data-note': 'comments' },
          text: `This file has ${state.comments} comment${state.comments === 1 ? '' : 's'}. An edit in the form writes the file again from its data and drops them; edits in the Text view keep them.`,
        }),
      );
    }
    if (state.view === 'form' && state.textIsSource && state.rewrittenTags > 0) {
      out.push(
        el('div', {
          class: 'callout small',
          text: `${state.rewrittenTags} short-form tag${state.rewrittenTags === 1 ? '' : 's'} (!Ref, !Sub …) will be written in long form ({Ref: …}, {Fn::Sub: …}) after a form edit. CloudFormation reads both the same.`,
        }),
      );
    }
    if (state.multi && state.format === 'json') {
      out.push(el('div', { class: 'callout small', text: 'Several documents saved as JSON become one list.' }));
    }
    replace(notes, ...out);
  }

  function renderSide(): void {
    if (!state) return;
    const findings = findingsNow();
    const counts = countBySeverity(findings);
    const changes = diff(state.original, state.current);
    const secrets = secretPaths(state.current);
    const p = profile();

    replace(
      summary,
      statGrid(
        stat({
          label: p.id === 'generic' ? 'Reads as' : 'Checks',
          value: parseError ? 'Unreadable' : p.id === 'generic' ? state.format.toUpperCase() : hasErrors(findings) ? 'Errors' : counts.warning > 0 ? 'Review' : 'Valid',
          tone: parseError || hasErrors(findings) ? 'danger' : counts.warning > 0 ? 'warn' : 'ok',
          sub: parseError ? 'fix the text' : `${p.id === 'generic' ? '' : `${p.label}: `}${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}`,
        }),
        stat({ label: 'Changed', value: changes.length, sub: `from ${state.name}` }),
        stat({
          label: 'Secrets held',
          value: secrets.length,
          sub: secrets.length > 0 ? 'in clear text' : 'none',
          tone: secrets.length > 0 ? 'warn' : 'ok',
        }),
      ),
    );

    const secretFindings = secrets.map((s) =>
      warning('editor.secret', 'A secret written in clear text.', { path: s, remediation: 'Download without secrets to share this file, or reference a vault instead.' }),
    );
    const all = [...findings, ...secretFindings.filter((s) => !findings.some((f) => f.path === s.path))];
    replace(
      validationBox,
      p.source ? el('div', { class: 'small muted', text: `Checked against: ${p.source}` }) : null,
      all.length === 0 ? el('div', { class: 'empty', text: 'Nothing to report.' }) : el('div', { class: 'stack' }, ...all.map(clickable)),
    );

    const show = (v: Json | undefined): string => {
      if (v === undefined) return '—';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 60 ? `${s.slice(0, 57)}…` : s;
    };
    replace(
      changesBox,
      changes.length === 0
        ? el('div', { class: 'empty', text: 'No changes from the file you opened.' })
        : el(
            'ul',
            { class: 'je-changes' },
            ...changes.map((c) => {
              const masked = isSecretPath(parsePath(c.path));
              return el(
                'li',
                { on: { click: () => focusPath(c.path) }, attrs: { title: `Go to ${c.path}` } },
                el('code', { text: c.path || '(whole file)' }),
                el('span', {
                  class: 'small',
                  text: c.kind === 'changed' ? ` ${show(masked ? '•••' : c.before)} → ${show(masked ? '•••' : c.after)}` : c.kind === 'added' ? ' added' : ' removed',
                }),
              );
            }),
          ),
    );

    if (document.activeElement !== textArea) textArea.value = state.text;
    renderGutter();
    renderNotes();
  }

  function renderControls(): void {
    if (!state) return;
    replace(profileSelect);
    for (const [family, ps] of profilesByFamily()) {
      const group = el('optgroup', { attrs: { label: FAMILY_LABELS[family] } });
      for (const p of ps) {
        group.appendChild(el('option', { text: p.id === state.profileId && state.detected ? `${p.label} (detected)` : p.label, attrs: { value: p.id } }));
      }
      profileSelect.appendChild(group);
    }
    profileSelect.value = state.profileId;
    replace(formatSelect);
    for (const f of ['json', 'yaml'] as const) formatSelect.appendChild(el('option', { text: f.toUpperCase(), attrs: { value: f } }));
    formatSelect.value = state.format;
    const tab = (v: View, text: string) =>
      el('button', {
        class: `btn btn-small${state!.view === v ? ' btn-primary' : ''}`,
        text,
        attrs: { type: 'button', role: 'tab', 'aria-selected': String(state!.view === v), 'data-view': v },
        on: {
          click: () => {
            if (!state || state.view === v) return;
            state.view = v;
            saveState(state);
            renderAll();
          },
        },
      });
    replace(viewTabs, tab('form', 'Form'), tab('text', 'Text'));
  }

  profileSelect.addEventListener('change', () => {
    if (!state) return;
    state.profileId = profileSelect.value;
    state.detected = false;
    saveState(state);
    renderAll();
  });
  formatSelect.addEventListener('change', () => {
    if (!state) return;
    const to = formatSelect.value as Format;
    if (to === state.format) return;
    if (parseError) {
      formatSelect.value = state.format;
      textStatus.textContent = 'Fix the text before converting it.';
      return;
    }
    history.push({ current: state.current, text: state.text, textIsSource: state.textIsSource });
    state.format = to;
    state.text = serialize(state.current, to, state.multi);
    state.textIsSource = false;
    state.comments = 0;
    lines = parseText(state.text, to).lines;
    state.name = state.name.replace(/\.(json|ya?ml)$/i, '') + (to === 'json' ? '.json' : '.yaml');
    saveState(state);
    renderAll();
  });

  function renderAll(): void {
    if (!state) return;
    renderControls();
    const text = state.view === 'text';
    tree.style.display = text ? 'none' : '';
    textPane.style.display = text ? '' : 'none';
    if (!text) renderTree();
    renderSide();
    if (text) textArea.value = state.text;
    renderGutter();
  }

  // --- find and replace ------------------------------------------------------
  const findInput = el('input', { attrs: { type: 'text', placeholder: 'Find, e.g. 10.20.1. or a site code', 'data-control': 'find' } }) as HTMLInputElement;
  const replaceInput = el('input', { attrs: { type: 'text', placeholder: 'Replace with', 'data-control': 'replace' } }) as HTMLInputElement;
  const findStatus = el('div', { class: 'field-hint' });
  findInput.addEventListener('input', () => {
    if (!state) return;
    const n = findReplace(state.current, findInput.value, replaceInput.value).changes.length;
    findStatus.textContent = findInput.value ? `${n} value${n === 1 ? '' : 's'} contain it.` : '';
  });
  const findCard = card(
    'Find and replace',
    el('p', {
      class: 'muted small',
      text: 'For the change that touches many fields at once — a new domain, a re-addressed subnet, a new site code in every hostname. Values only; field names are never renamed.',
    }),
    el('div', { class: 'field-row' }, el('div', { class: 'field' }, findInput), el('div', { class: 'field' }, replaceInput)),
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary btn-small',
        text: 'Replace all',
        on: {
          click: () => {
            if (!state || !findInput.value) return;
            const result = findReplace(state.current, findInput.value, replaceInput.value);
            commit(result.doc, true);
            findStatus.textContent = `Replaced in ${result.changes.length} value${result.changes.length === 1 ? '' : 's'}.`;
          },
        },
      }),
    ),
    findStatus,
  );

  // --- toolbar -----------------------------------------------------------------
  const fileName = (suffix = '') => {
    const name = state?.name ?? 'document.json';
    const ext = state?.format === 'yaml' ? (/\.yml$/i.test(name) ? '.yml' : '.yaml') : name.match(/\.tfvars\.json$|\.tf\.json$/i)?.[0] ?? '.json';
    const base = name.replace(/(\.tfvars|\.tf)?\.(json|ya?ml)$/i, '');
    return `${base}${suffix ? `-${suffix}` : ''}${ext}`;
  };
  const mime = () => (state?.format === 'yaml' ? 'application/yaml' : 'application/json');
  const toolbar = card(
    'File',
    el(
      'div',
      { class: 'field-row' },
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Kind of file' }), profileSelect),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Format' }), formatSelect),
    ),
    summary,
    notes,
    el(
      'div',
      { class: 'btn-row', style: { marginTop: 'var(--space-4)' } },
      el('button', {
        class: 'btn btn-primary',
        text: 'Download',
        attrs: { 'data-control': 'download' },
        on: { click: () => state && downloadFile(fileName('edited'), state.text, mime()) },
      }),
      el('button', {
        class: 'btn',
        text: 'Download without secrets',
        attrs: { title: 'Every clear-text secret replaced by <REQUIRED>, for sharing', 'data-control': 'download-redacted' },
        on: { click: () => state && downloadFile(fileName('redacted'), serialize(redactSecrets(state.current), state.format, state.multi), mime()) },
      }),
      el('button', { class: 'btn', text: 'Undo', attrs: { 'data-control': 'undo' }, on: { click: undo } }),
      el('button', {
        class: 'btn',
        text: 'Back to as opened',
        on: {
          click: () => {
            if (!state) return;
            commit(state.original, true);
          },
        },
      }),
      el('button', {
        class: 'btn',
        text: 'Close',
        on: {
          click: () => {
            state = null;
            saveState(null);
            workspace.style.display = 'none';
            replace(tree);
          },
        },
      }),
    ),
    el('div', {
      class: 'section-note',
      text: 'Download keeps the file as written when it was last edited as text; after a form edit it is written again from the data. Click a finding or a change to go to it.',
    }),
  );

  append(
    workspace,
    el('div', { class: 'stack' }, viewTabs, tree, textPane),
    el('div', { class: 'stack je-side' }, toolbar, card('Checks', validationBox), card('Changes from the file you opened', changesBox), findCard),
  );
  append(root, loadCard, workspace);

  // A spec sent from the builder wins; otherwise pick up where this tab was.
  const sent = takeHandoff<Json>('spec-to-editor');
  if (sent) open(sent.origin.endsWith('.json') ? sent.origin : `${sent.origin}.json`, sent.payload, 'json', profileById('vcf-spec'));
  else {
    const kept = loadState();
    if (kept) {
      state = kept;
      try {
        lines = parseText(kept.text, kept.format).lines;
      } catch (err) {
        parseError = { message: (err as Error).message, line: err instanceof YamlError ? err.line : undefined };
      }
      workspace.style.display = '';
      renderAll();
    }
  }
}

const target = typeof document !== 'undefined' ? document.getElementById('data-editor-root') : null;
if (target) mountDataEditorPage(target as HTMLElement);

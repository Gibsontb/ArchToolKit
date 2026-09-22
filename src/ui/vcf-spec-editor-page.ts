/**
 * VCF deployment specification editor.
 *
 * Open a spec — an installer export from a lab, or one the spec builder wrote —
 * and change it field by field while it is checked against the VCF 9.1 schema
 * as you type. Built for the moment some of the systems change: a host is
 * swapped, a subnet is re-addressed, a naming standard arrives. Everything that
 * is not changing stays exactly as it was, and the list of changes says what
 * is different from the document you opened.
 *
 * Nothing leaves the page. The document is kept in this tab only, so a reload
 * does not lose work; an installer export carries the ESX root password in
 * clear text, which is why "Download without passwords" exists and why the
 * page says when it is holding one.
 */

import { el, append, replace, downloadFile, readFileAsText } from './dom.ts';
import { card, findingsList, stat, statGrid } from './components.ts';
import { countBySeverity, hasErrors, type Finding } from '../core/findings.ts';
import { validateSddcSpec } from '../vcf/spec-validate.ts';
import type { SddcSpec } from '../vcf/spec-types.ts';
import {
  choicesFor,
  diff,
  findReplace,
  getAt,
  isSecretPath,
  labelFor,
  moveAt,
  newEntry,
  parsePath,
  pathString,
  redactSecrets,
  removeAt,
  secretPaths,
  setAt,
  type Json,
  type Path,
} from '../vcf/spec-edit.ts';
import { takeHandoff } from './handoff.ts';
import { mountFlowSteps } from './flow-steps.ts';

const STORE_KEY = 'archtoolkit.spec-editor';

interface EditorState {
  name: string;
  original: Json;
  current: Json;
}

function saveState(state: EditorState | null): void {
  try {
    if (state) sessionStorage.setItem(STORE_KEY, JSON.stringify(state));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    // A document too large for the tab store is still edited; only a reload
    // would lose it.
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

/** What to call an entry in a list, so twelve cards are not all "#3". */
function itemTitle(value: Json, index: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, Json>;
    const name =
      v.hostname ?? v.networkType ?? v.dvsName ?? v.name ?? v.datastoreName ?? v.id ?? v.type ?? v.cidr ?? v.startIpAddress;
    if (typeof name === 'string' && name) return `${index + 1} · ${name}`;
  }
  return `${index + 1}`;
}

export function mountSpecEditorPage(root: HTMLElement): void {
  let state: EditorState | null = null;
  const history: Json[] = [];

  const tree = el('div', { class: 'je-tree' });
  const validationBox = el('div', {});
  const changesBox = el('div', {});
  const summary = el('div', {});
  const raw = el('textarea', { class: 'je-raw', attrs: { rows: '18', spellcheck: 'false' } }) as HTMLTextAreaElement;
  const rawStatus = el('div', { class: 'field-hint' });
  const loadStatus = el('div', { class: 'field-hint' });
  const workspace = el('div', { class: 'split je-split', style: { display: 'none' } });

  // --- loading ---------------------------------------------------------------
  function open(name: string, json: string | Json): void {
    let doc: Json;
    try {
      doc = typeof json === 'string' ? (JSON.parse(json) as Json) : json;
    } catch (err) {
      loadStatus.textContent = `That is not JSON: ${(err as Error).message}`;
      return;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      loadStatus.textContent = 'A deployment specification is a JSON object; this is not one.';
      return;
    }
    state = { name, original: doc, current: doc };
    history.length = 0;
    loadStatus.textContent = '';
    workspace.style.display = '';
    renderAll();
  }

  const fileInput = el('input', { attrs: { type: 'file', accept: '.json,application/json' } }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void readFileAsText(file).then((text) => open(file.name, text));
  });
  const paste = el('textarea', {
    attrs: { rows: '4', placeholder: 'Or paste a deployment specification here…', spellcheck: 'false' },
  }) as HTMLTextAreaElement;

  const loadCard = card(
    'Open a specification',
    el('p', {
      class: 'muted small',
      text: 'An installer export (VCF-deployment-spec-….json) or a spec from the builder. It is read in this page and kept in this tab only.',
    }),
    el('div', { class: 'field' }, fileInput),
    el('div', { class: 'field' }, paste),
    el(
      'div',
      { class: 'btn-row' },
      el('button', { class: 'btn', text: 'Open pasted JSON', on: { click: () => open('pasted.json', paste.value) } }),
      el('a', { class: 'btn', text: 'Build a new one instead', attrs: { href: 'vcf-spec.html' } }),
    ),
    loadStatus,
  );

  // --- editing ---------------------------------------------------------------
  function commit(next: Json, structural: boolean): void {
    if (!state) return;
    history.push(state.current);
    if (history.length > 200) history.shift();
    state.current = next;
    saveState(state);
    if (structural) renderTree();
    renderSide();
  }

  function undo(): void {
    if (!state || history.length === 0) return;
    state.current = history.pop() as Json;
    saveState(state);
    renderAll();
  }

  /** The control for one value, bound to its path. */
  function valueControl(path: Path, value: Json): HTMLElement {
    const at = pathString(path);
    const choices = choicesFor(path);
    const setValue = (next: Json) => commit(setAt(state!.current, path, next), false);

    if (typeof value === 'boolean') {
      const s = el('select', { attrs: { 'data-path': at } }) as HTMLSelectElement;
      for (const v of ['true', 'false']) s.appendChild(el('option', { text: v, attrs: { value: v } }));
      s.value = String(value);
      s.addEventListener('change', () => setValue(s.value === 'true'));
      return s;
    }
    if (choices && (typeof value === 'string' || value === null)) {
      const s = el('select', { attrs: { 'data-path': at } }) as HTMLSelectElement;
      const options = [...choices];
      if (typeof value === 'string' && !options.includes(value)) options.unshift(value);
      for (const v of options) s.appendChild(el('option', { text: v === '' ? '(empty)' : v, attrs: { value: v } }));
      s.value = String(value ?? '');
      s.addEventListener('change', () => setValue(s.value));
      return s;
    }
    const secret = isSecretPath(path);
    const input = el('input', {
      attrs: {
        'data-path': at,
        type: secret ? 'password' : typeof value === 'number' ? 'number' : 'text',
        spellcheck: 'false',
        autocomplete: 'off',
      },
    }) as HTMLInputElement;
    input.value = value === null ? '' : String(value);
    input.addEventListener('input', () => {
      if (typeof value === 'number') {
        const n = Number(input.value);
        setValue(input.value.trim() === '' || !Number.isFinite(n) ? input.value : n);
      } else setValue(input.value);
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

  function itemButtons(path: Path, list: readonly Json[]): HTMLElement {
    const index = path[path.length - 1] as number;
    const b = (text: string, title: string, act: () => void, disabled = false) =>
      el('button', {
        class: 'btn btn-small',
        text,
        attrs: { type: 'button', title, ...(disabled ? { disabled: 'disabled' } : {}) },
        on: { click: act },
      });
    return el(
      'span',
      { class: 'je-actions' },
      b('↑', 'Move up', () => commit(moveAt(state!.current, path, -1), true), index === 0),
      b('↓', 'Move down', () => commit(moveAt(state!.current, path, 1), true), index === list.length - 1),
      b('Copy', 'Duplicate this entry', () => {
        const parent = path.slice(0, -1);
        const copy = structuredClone(list[index]) as Json;
        const next = [...list.slice(0, index + 1), copy, ...list.slice(index + 1)];
        commit(setAt(state!.current, parent, next), true);
      }),
      b('Remove', 'Remove this entry', () => commit(removeAt(state!.current, path), true)),
    );
  }

  function node(path: Path, value: Json, label: string): HTMLElement {
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
              el('summary', {}, el('span', { text: itemTitle(item, i) }), itemButtons(itemPath, value)),
              objectBody(itemPath, item),
            ),
          );
        } else {
          append(body, el('div', { class: 'je-row' }, valueControl(itemPath, item), itemButtons(itemPath, value)));
        }
      });
      append(
        body,
        el('button', {
          class: 'btn btn-small je-add',
          text: `Add to ${label.toLowerCase()}`,
          attrs: { type: 'button' },
          on: { click: () => commit(setAt(state!.current, [...path, value.length], newEntry(value)), true) },
        }),
      );
      return el('div', { class: 'je-field je-field-block' }, el('div', { class: 'je-label', text: `${label} (${value.length})` }), body);
    }
    if (value !== null && typeof value === 'object') {
      return el(
        'details',
        { class: 'je-group', attrs: { open: 'open', 'data-section': pathString(path) } },
        el('summary', { text: label }),
        objectBody(path, value),
      );
    }
    return el('label', { class: 'je-field' }, el('span', { class: 'je-label', text: label }), valueControl(path, value));
  }

  function objectBody(path: Path, value: Json): HTMLElement {
    const body = el('div', { class: 'je-body' });
    const entries = Object.entries(value as Record<string, Json>);
    // Plain values first, then lists and groups, so a section reads as a form.
    const simple = entries.filter(([, v]) => v === null || typeof v !== 'object');
    const nested = entries.filter(([, v]) => v !== null && typeof v === 'object');
    for (const [k, v] of [...simple, ...nested]) append(body, node([...path, k], v, labelFor(k)));
    if (entries.length === 0) append(body, el('div', { class: 'muted small', text: 'Empty — the installer uses its defaults.' }));
    return body;
  }

  function renderTree(): void {
    if (!state) return;
    const doc = state.current as Record<string, Json>;
    const sections = Object.entries(doc).map(([key, value], i) => {
      const path = [key];
      if (value !== null && typeof value === 'object') {
        const section = el(
          'details',
          { class: 'je-section card', attrs: { 'data-section': key, ...(i < 12 ? { open: 'open' } : {}) } },
          el('summary', { class: 'card-title', text: labelFor(key) }),
          Array.isArray(value) ? node(path, value, labelFor(key)) : objectBody(path, value),
        );
        return section;
      }
      return null;
    });
    const scalars = Object.entries(doc).filter(([, v]) => v === null || typeof v !== 'object');
    replace(
      tree,
      card('Instance', ...scalars.map(([k, v]) => node([k], v, labelFor(k)))),
      ...sections.filter((s) => s !== null),
    );
  }

  /** Put the cursor on a field a finding or a change points at. */
  function focusPath(at: string): void {
    const target =
      tree.querySelector<HTMLElement>(`[data-path="${CSS.escape(at)}"]`) ??
      tree.querySelector<HTMLElement>(`[data-section="${CSS.escape(at)}"]`);
    if (!target) return;
    for (let n: HTMLElement | null = target; n; n = n.parentElement) {
      if (n.tagName === 'DETAILS') (n as HTMLDetailsElement).open = true;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.focus?.();
    target.classList.add('je-flash');
    setTimeout(() => target.classList.remove('je-flash'), 1600);
  }

  function clickable(f: Finding): HTMLElement {
    const item = findingsList([f]);
    if (f.path) {
      item.style.cursor = 'pointer';
      item.title = `Go to ${f.path}`;
      item.addEventListener('click', () => focusPath(f.path as string));
    }
    return item;
  }

  function renderSide(): void {
    if (!state) return;
    const findings = validateSddcSpec(state.current as unknown as SddcSpec);
    const counts = countBySeverity(findings);
    const changes = diff(state.original, state.current);
    const secrets = secretPaths(state.current);

    replace(
      summary,
      statGrid(
        stat({
          label: 'Against the 9.1 schema',
          value: hasErrors(findings) ? 'Rejected' : counts.warning > 0 ? 'Review' : 'Valid',
          tone: hasErrors(findings) ? 'danger' : counts.warning > 0 ? 'warn' : 'ok',
          sub: `${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}`,
        }),
        stat({ label: 'Changed', value: changes.length, sub: `from ${state.name}` }),
        stat({
          label: 'Passwords held',
          value: secrets.length,
          sub: secrets.length > 0 ? 'in clear text' : 'none',
          tone: secrets.length > 0 ? 'warn' : 'ok',
        }),
      ),
    );

    replace(
      validationBox,
      findings.length === 0
        ? el('div', { class: 'empty', text: 'Nothing to report.' })
        : el('div', { class: 'stack' }, ...findings.map(clickable)),
    );

    const show = (v: Json | undefined): string => {
      if (v === undefined) return '—';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 60 ? `${s.slice(0, 57)}…` : s;
    };
    replace(
      changesBox,
      changes.length === 0
        ? el('div', { class: 'empty', text: 'No changes from the document you opened.' })
        : el(
            'ul',
            { class: 'je-changes' },
            ...changes.map((c) =>
              el(
                'li',
                { on: { click: () => focusPath(c.path) }, attrs: { title: `Go to ${c.path}` } },
                el('code', { text: c.path }),
                el('span', {
                  class: 'small',
                  text:
                    c.kind === 'changed'
                      ? ` ${show(isSecretPath(parsePath(c.path)) ? '•••' : c.before)} → ${show(isSecretPath(parsePath(c.path)) ? '•••' : c.after)}`
                      : c.kind === 'added'
                        ? ' added'
                        : ' removed',
                }),
              ),
            ),
          ),
    );

    if (document.activeElement !== raw) raw.value = JSON.stringify(state.current, null, 2);
  }

  function renderAll(): void {
    renderTree();
    renderSide();
  }

  // --- find and replace ------------------------------------------------------
  const findInput = el('input', { attrs: { type: 'text', placeholder: 'Find, e.g. 10.20.1. or a site code' } }) as HTMLInputElement;
  const replaceInput = el('input', { attrs: { type: 'text', placeholder: 'Replace with' } }) as HTMLInputElement;
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
      text: 'For the change that touches many fields at once — a new domain, a re-addressed subnet, a new site code in every hostname. Values only; the field names are the schema and are never renamed.',
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

  // --- raw JSON --------------------------------------------------------------
  const rawCard = card(
    'JSON',
    raw,
    el(
      'div',
      { class: 'btn-row' },
      el('button', {
        class: 'btn btn-small',
        text: 'Apply the JSON above',
        on: {
          click: () => {
            try {
              commit(JSON.parse(raw.value) as Json, true);
              rawStatus.textContent = 'Applied.';
            } catch (err) {
              rawStatus.textContent = `Not applied — ${(err as Error).message}`;
            }
          },
        },
      }),
    ),
    rawStatus,
  );

  // --- toolbar -----------------------------------------------------------------
  const fileName = (suffix = '') =>
    (state?.name ?? 'vcf-deployment-spec.json').replace(/\.json$/i, '') + (suffix ? `-${suffix}` : '') + '.json';
  const toolbar = card(
    'Save',
    summary,
    el(
      'div',
      { class: 'btn-row', style: { marginTop: 'var(--space-4)' } },
      el('button', {
        class: 'btn btn-primary',
        text: 'Download JSON',
        on: { click: () => state && downloadFile(fileName('edited'), `${JSON.stringify(state.current, null, 2)}\n`) },
      }),
      el('button', {
        class: 'btn',
        text: 'Download without passwords',
        attrs: { title: 'Every password replaced by <REQUIRED>, for sharing' },
        on: {
          click: () =>
            state && downloadFile(fileName('redacted'), `${JSON.stringify(redactSecrets(state.current), null, 2)}\n`),
        },
      }),
      el('button', { class: 'btn', text: 'Undo', on: { click: undo } }),
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
      text: 'The document is checked with the same validator as the builder: every error is a field the installer would refuse. Click a finding or a change to go to its field.',
    }),
  );

  append(
    workspace,
    el('div', { class: 'stack' }, tree),
    el(
      'div',
      { class: 'stack je-side' },
      toolbar,
      card('Checks', validationBox),
      card('Changes from the document you opened', changesBox),
      findCard,
      rawCard,
    ),
  );
  append(root, loadCard, workspace);
  mountFlowSteps(root, 'spec');

  // A spec sent from the builder wins; otherwise pick up where this tab was.
  const sent = takeHandoff<Json>('spec-to-editor');
  if (sent) open(sent.origin, sent.payload);
  else {
    const kept = loadState();
    if (kept) {
      state = kept;
      workspace.style.display = '';
      renderAll();
    }
  }
}

const target = typeof document !== 'undefined' ? document.getElementById('vcf-spec-editor-root') : null;
if (target) mountSpecEditorPage(target as HTMLElement);

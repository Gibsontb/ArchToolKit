/**
 * ArchPad's editor core: tabs, split view, menus, status bar, files,
 * sessions, search, bookmarks, macros and compare, on CodeMirror 6.
 *
 * `mountArchPad` is the only entry point. It owns the DOM inside `root` and
 * talks to the outside world only through the Host (files, title, closing),
 * so the toolkit page and ArchPad.exe run this same code.
 *
 * Documents are plain records holding a CodeMirror EditorState. At most two
 * EditorViews exist (the two sides of split view); switching tabs swaps the
 * state into a view, so undo history, selection, folds and bookmarks travel
 * with the document. Settings that apply to every document (word wrap,
 * whitespace, the language of each doc) live in compartments and are
 * re-applied whenever a state is shown.
 */

import { el, replace } from '../ui/dom.js';
import {
  EditorState,
  EditorSelection,
  Compartment,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightWhitespace,
  highlightTrailingWhitespace,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  selectAll,
  indentMore,
  indentLess,
  copyLineDown,
  moveLineDown,
  moveLineUp,
  deleteLine,
  cursorMatchingBracket,
  selectMatchingBracket,
  toggleBlockComment,
  toggleLineComment,
  lineComment,
  lineUncomment,
  addCursorAbove,
  addCursorBelow,
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldAll,
  unfoldAll,
  foldCode,
  unfoldCode,
  indentOnInput,
  indentUnit,
  highlightSelectionMatches,
  selectNextOccurrence,
  selectSelectionMatches,
} from '../vendor/archpad-editor.js';
                                                                                                                     
import { ALL_ENCODINGS, ENCODING_LABELS, EOL_LABELS, convertEol, decode, decodeFile, encode, encodeFile, looksBinary, unmappableCount } from './encoding.js';
import { LANGUAGES, detectLanguage, detectFromContent, languageLabel } from './lang-detect.js';
import { hasLanguage, languageExtension } from './languages.js';
import * as ops from './lineops.js';
import {
  archpadHighlight,
  archpadTheme,
  bookmarkField,
  bookmarkGutter,
  bookmarkedLines,
  eolField,
  eolMarkers,
  indentGuides,
  markField,
  overwriteMode,
  setBookmarks,
  setEol,
  toggleBookmark,
} from './editor-ext.js';
import { createMenuBar,                             } from './menus.js';
import { eventToShortcut, normalizeShortcut } from './shortcuts.js';
import { checkbox, confirmDialog, field, messageDialog, openDialog, pickDialog, promptDialog, radioGroup, saveChangesDialog, selectInput, textInput } from './dialogs.js';
import { clearMarks, findInView, openFindDialog, closeFindDialog, replaceAllInView, search,                                } from './findui.js';
import { MacroRecorder, describeStep, editingKeys, runKey,                                 } from './macros.js';
import { loadJson, loadRecent, loadSession, saveJson, saveRecent, saveSession,                                                    } from './session.js';
import { openPalette,                  } from './palette.js';
import { openCompare,                     } from './compare.js';
import { grid, table } from './tools/panel.js';

// The vendor bundle ships without type declarations; these aliases name what the core relies on.
/* eslint-disable @typescript-eslint/no-explicit-any */
                 
                
                   

                                                           

// ---- Records ------------------------------------------------------------------

               
                      
               
                
                   
                        
                    
                     
           
                   
                          
                    
                  
                                                                                  
               
                                                                              
                    
                                                             
                     
                 
                 
                                                                                                   
                     
 

                   
                       
                        
                        
                         
                            
                                 
                              
                               
                     
                             
                                    
                              
                            
                              
                               
                           
                         
                                         
                              
 

                
                           
                      
                
 

                                       

                    
                
                      
               
                  
                       
                   
               
                  
                     
                  
 

const DEFAULT_SETTINGS           = {
  wrap: false,
  whitespace: false,
  eol: false,
  guides: true,
  lineNumbers: true,
  fontSize: 14,
  theme: 'auto',
  tabSize: 4,
  useSpaces: false,
  defaultEol: 'CRLF',
};

/** A command as the core keeps it: tools and built-ins alike. */
               
                      
                         
                                                                                 
                        
                             
                                                           
                                    
                                                                                                
                              
                              
                                   
                           
                                   
                                                                           
                              
                                         
                            
                                                     
                                       
 

const SETTINGS_KEY = 'archpad.settings.v1';
const MACROS_KEY = 'archpad.macros.v1';
const MAX_RECENT = 15;
const MAX_CLOSED = 20;

// ---- Pure helpers ---------------------------------------------------------------

let idCounter = 0;
function newId()         {
  idCounter += 1;
  return `d${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Column as Notepad++ counts it: tabs expand to the next stop. 0-based. */
export function visualColumn(text        , tabSize        )         {
  let c = 0;
  for (const ch of text) c = ch === '\t' ? c + tabSize - (c % tabSize) : c + 1;
  return c;
}

/** The smallest "new N" not already used. */
export function nextUntitledName(names                   )         {
  const used = new Set(names.map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) if (!used.has(`new ${i}`)) return `new ${i}`;
}

/** Accept a language id, a label ("YAML") or an extension ("yml"). */
export function resolveLanguage(value                    )                {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/^\./, '');
  if (hasLanguage(v)) return v;
  const byLabel = LANGUAGES.find((l) => l.label.toLowerCase() === v);
  if (byLabel) return byLabel.id;
  const byExt = LANGUAGES.find((l) => l.ext?.includes(v));
  return byExt ? byExt.id : null;
}

function errorText(err         )         {
  return err instanceof Error ? err.message : String(err);
}

function plural(n        , word        )         {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---- Mount ----------------------------------------------------------------------

export function mountArchPad(root             , host      , options               = {})             {
  const layout = options.layout ?? 'page';
  const settings           = { ...DEFAULT_SETTINGS, ...loadJson                   (SETTINGS_KEY, {}) };
  const docs        = [];
  const panes         = [];
  let focusIdx = 0;
  let splitOpen = false;
  let overwrite = false;
  let restored = false;
  let recent               = [];
  const closedStack               = [];
  let compare                        = null;
  const recorder = new MacroRecorder();
  let lastMacro              = [];
  let savedMacros               = loadJson              (MACROS_KEY, []);
  let playing = false;

  // ---- DOM skeleton -------------------------------------------------------------

  replace(root);
  root.classList.add('ap-root', `ap-layout-${layout}`);
  root.setAttribute('data-archpad', '');
  const topBar = el('div', { class: 'ap-top' });
  const tabBar = el('div', { class: 'ap-tabbar', attrs: { role: 'tablist', 'aria-label': 'Open documents' } });
  const panesEl = el('div', { class: 'ap-panes' });
  const main = el('div', { class: 'ap-main' }, panesEl);
  const panelTitle = el('strong', { class: 'ap-panel-title' });
  const panelBody = el('div', { class: 'ap-panel-body' });
  const panelGrip = el('div', { class: 'ap-panel-grip', attrs: { title: 'Drag to resize', 'aria-hidden': 'true' } });
  const panel = el(
    'section',
    { class: 'ap-panel', attrs: { 'aria-label': 'Results' } },
    panelGrip,
    el(
      'div',
      { class: 'ap-panel-head' },
      panelTitle,
      el('button', { class: 'ap-x', text: '×', attrs: { type: 'button', 'aria-label': 'Close panel', title: 'Close (F7 toggles)' }, on: { click: () => hidePanel() } }),
    ),
    panelBody,
  );
  panel.hidden = true;
  const sMsg = el('span', { class: 'ap-st-msg', attrs: { role: 'status', 'aria-live': 'polite' } });
  const sRec = el('span', { class: 'ap-st-rec', text: '● REC', attrs: { title: 'Recording a macro (Ctrl+Shift+R stops)' } });
  sRec.hidden = true;
  const sLen = el('span', { class: 'ap-st-item' });
  const sPos = el('span', { class: 'ap-st-item ap-st-pos', attrs: { title: 'Go to line (Ctrl+G)' } });
  const stButton = (title        )                    => el('button', { class: 'ap-st-item ap-st-btn', attrs: { type: 'button', title } })                     ;
  const sEol = stButton('Line ending: click to convert');
  const sEnc = stButton('Encoding: click to change');
  const sLang = stButton('Language: click to change');
  const sIns = stButton('Insert / overwrite (Insert key)');
  const statusBar = el('div', { class: 'ap-status' }, sMsg, sRec, sLen, sPos, sEol, sEnc, sLang, sIns);
  root.append(topBar, tabBar, main, panel, statusBar);

  // ---- Editor configuration -----------------------------------------------------

  const cLang = new Compartment();
  const cWrap = new Compartment();
  const cWs = new Compartment();
  const cEol = new Compartment();
  const cGuides = new Compartment();
  const cGutter = new Compartment();
  const cReadOnly = new Compartment();
  const cTabs = new Compartment();

  const WS_ON = [highlightWhitespace(), highlightTrailingWhitespace()];
  const GUTTER_ON = [lineNumbers(), highlightActiveLineGutter()];
  const updateListener = EditorView.updateListener.of((u     ) => onViewUpdate(u));
  const BASE = [
    bookmarkField,
    markField,
    eolField,
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    highlightActiveLine(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    bracketMatching(),
    indentOnInput(),
    highlightSelectionMatches(),
    archpadHighlight,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    archpadTheme,
    // The recorder first: it only listens, and overwrite mode consumes the input.
    recorder.inputRecorder(),
    overwriteMode(() => overwrite),
    keymap.of([...foldKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    updateListener,
  ];
  const FOLD = foldGutter({ markerDOM: (open         ) => el('span', { class: `ap-fold ${open ? 'is-open' : 'is-closed'}`, text: open ? '⊟' : '⊞' }) });

  const tabExt = ()          => [EditorState.tabSize.of(settings.tabSize), indentUnit.of(settings.useSpaces ? ' '.repeat(settings.tabSize) : '\t')];

  function buildExtensions(doc     )            {
    return [
      bookmarkGutter,
      cGutter.of(settings.lineNumbers ? GUTTER_ON : []),
      FOLD,
      ...BASE,
      cLang.of(languageExtension(doc.language)),
      cWrap.of(settings.wrap ? EditorView.lineWrapping : []),
      cWs.of(settings.whitespace ? WS_ON : []),
      cEol.of(settings.eol ? eolMarkers : []),
      cGuides.of(settings.guides ? indentGuides : []),
      cReadOnly.of(EditorState.readOnly.of(doc.readOnly)),
      cTabs.of(tabExt()),
    ];
  }

  function reconfigureEffects(doc     )            {
    return [
      cGutter.reconfigure(settings.lineNumbers ? GUTTER_ON : []),
      cLang.reconfigure(languageExtension(doc.language)),
      cWrap.reconfigure(settings.wrap ? EditorView.lineWrapping : []),
      cWs.reconfigure(settings.whitespace ? WS_ON : []),
      cEol.reconfigure(settings.eol ? eolMarkers : []),
      cGuides.reconfigure(settings.guides ? indentGuides : []),
      cReadOnly.reconfigure(EditorState.readOnly.of(doc.readOnly)),
      cTabs.reconfigure(tabExt()),
    ];
  }

  // ---- Documents ------------------------------------------------------------------

  const byId = (id                           )                  => (id ? docs.find((d) => d.id === id) : undefined);
  const livePanes = ()         => (splitOpen ? panes : panes.slice(0, 1));
  const paneOf = (doc     )                   => livePanes().find((p) => p.docId === doc.id);
  const stateOf = (doc     )        => paneOf(doc)?.view.state ?? doc.state;
  const activePane = ()       => panes[focusIdx] ?? panes[0] ;
  const activeView = ()       => activePane().view;
  const activeDoc = ()      => byId(activePane().docId) ?? docs[0] ;

  function computeDirty(doc     , state       )          {
    if (doc.metaDirty) return true;
    return state.doc.length !== doc.savedDoc.length || !state.doc.eq(doc.savedDoc);
  }

  function refreshDirty(doc     , state        = stateOf(doc))       {
    const dirty = computeDirty(doc, state);
    if (dirty !== doc.dirty) {
      doc.dirty = dirty;
      renderTabs();
      updateTitle();
    }
    if (dirty && doc.bytes && !doc.metaDirty) doc.bytes = undefined;
  }

  function createDoc(init         )      {
    const doc      = {
      id: init.id ?? newId(),
      name: init.name,
      path: init.path,
      handle: init.handle,
      lastModified: init.lastModified,
      untitled: init.untitled ?? false,
      encoding: init.encoding ?? 'utf-8',
      eol: init.eol ?? settings.defaultEol,
      language: init.language && hasLanguage(init.language) ? init.language : 'text',
      languageLocked: init.languageLocked ?? false,
      readOnly: init.readOnly ?? false,
      pinned: init.pinned ?? false,
      state: null,
      savedDoc: null,
      metaDirty: init.metaDirty ?? false,
      dirty: false,
      scroll: 0,
      bytes: init.bytes,
    };
    let state = EditorState.create({ doc: init.text, extensions: buildExtensions(doc) });
    const len = state.doc.length;
    const clamp = (n                    )         => Math.max(0, Math.min(len, n ?? 0));
    const effects            = [setEol.of(doc.eol)];
    const lines = (init.bookmarks ?? []).filter((n) => n >= 1 && n <= state.doc.lines);
    if (lines.length) effects.push(setBookmarks.of(lines.map((n) => state.doc.line(n).from)));
    state = state.update({ effects, selection: EditorSelection.single(clamp(init.anchor), clamp(init.head ?? init.anchor)) }).state;
    doc.state = state;
    doc.savedDoc = init.savedText !== undefined ? EditorState.create({ doc: init.savedText }).doc : state.doc;
    doc.dirty = computeDirty(doc, state);
    return doc;
  }

  /** Apply a transaction spec to a document whether or not it is on screen. */
  function applyToDoc(doc     , spec                         )       {
    const pane = paneOf(doc);
    if (pane) {
      pane.view.dispatch(spec);
      return;
    }
    doc.state = doc.state.update(spec).state;
    refreshDirty(doc, doc.state);
    scheduleSession();
  }

  function setDocText(doc     , text        )       {
    const state = stateOf(doc);
    if (state.doc.toString() === text) return;
    const head = Math.min(state.selection.main.head, text.length);
    applyToDoc(doc, { changes: { from: 0, to: state.doc.length, insert: text }, selection: { anchor: head }, userEvent: 'input', scrollIntoView: true });
  }

  function isPristine(doc     )          {
    return doc.untitled && !doc.dirty && stateOf(doc).doc.length === 0;
  }

  function insertDoc(doc     , afterActive = true)       {
    const at = afterActive && docs.length ? docs.indexOf(activeDoc()) + 1 : docs.length;
    docs.splice(at, 0, doc);
  }

  function newUntitled(text = '', name         , language         )      {
    const doc = createDoc({
      name: name ?? nextUntitledName(docs.map((d) => d.name)),
      text,
      untitled: true,
      language: language ?? 'text',
      languageLocked: !!language,
      savedText: '',
    });
    insertDoc(doc);
    return doc;
  }

  // ---- Panes and views ------------------------------------------------------------

  function makePane(doc     )       {
    const paneEl = el('div', { class: 'ap-pane' });
    panesEl.appendChild(paneEl);
    const view = new EditorView({ state: doc.state, parent: paneEl });
    const pane       = { el: paneEl, view, docId: doc.id };
    view.contentDOM.addEventListener('focus', () => setFocus(panes.indexOf(pane)));
    paneEl.addEventListener('mousedown', () => {
      if (panes.indexOf(pane) !== focusIdx) setFocus(panes.indexOf(pane));
    });
    paneEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (panes.indexOf(pane) !== focusIdx) setFocus(panes.indexOf(pane));
      menuBar.context(editorContextMenu(), e.clientX, e.clientY);
    });
    panes.push(pane);
    view.dispatch({ effects: reconfigureEffects(doc) });
    return pane;
  }

  function showDoc(pane      , doc     )       {
    if (pane.docId === doc.id) return;
    const current = byId(pane.docId);
    if (current) {
      current.state = pane.view.state;
      current.scroll = pane.view.scrollDOM.scrollTop;
    }
    pane.docId = doc.id;
    pane.view.setState(doc.state);
    pane.view.dispatch({ effects: reconfigureEffects(doc) });
    const top = doc.scroll;
    requestAnimationFrame(() => {
      if (pane.docId === doc.id) pane.view.scrollDOM.scrollTop = top;
    });
  }

  function setFocus(i        )       {
    if (i < 0 || !panes[i] || (i === 1 && !splitOpen)) return;
    const changed = focusIdx !== i;
    focusIdx = i;
    panes.forEach((p, k) => p.el.classList.toggle('is-focused', k === i && splitOpen));
    if (changed) refreshUi();
  }

  function activate(doc     , focus = true)       {
    if (compare) closeCompare();
    const shownIn = livePanes().findIndex((p) => p.docId === doc.id);
    if (shownIn >= 0) setFocus(shownIn);
    else showDoc(activePane(), doc);
    refreshUi();
    if (focus) activeView().focus();
  }

  function openSplit(doc     )       {
    if (!panes[1]) {
      splitOpen = true;
      makePane(doc);
    } else {
      splitOpen = true;
      panes[1].el.hidden = false;
      showDoc(panes[1], doc);
    }
    root.classList.add('is-split');
    setFocus(1);
    refreshUi();
    scheduleSession();
  }

  function closeSplit()       {
    if (!splitOpen) return;
    const p = panes[1] ;
    const d = byId(p.docId);
    if (d) {
      d.state = p.view.state;
      d.scroll = p.view.scrollDOM.scrollTop;
    }
    p.docId = '';
    p.el.hidden = true;
    splitOpen = false;
    focusIdx = 0;
    root.classList.remove('is-split');
    panes[0] .el.classList.remove('is-focused');
    refreshUi();
    scheduleSession();
  }

  function moveToOtherView()       {
    const doc = activeDoc();
    if (!splitOpen) {
      const replacement = docs.find((d) => d !== doc) ?? newUntitled();
      showDoc(panes[0] , replacement);
      openSplit(doc);
      return;
    }
    const src = activePane();
    const target = panes[1 - focusIdx] ;
    const candidates = docs.filter((d) => d !== doc && d.id !== target.docId);
    if (!candidates.length) {
      if (focusIdx === 1) {
        closeSplit();
        activate(doc);
        return;
      }
      showDoc(src, newUntitled());
    } else showDoc(src, candidates[0] );
    showDoc(target, doc);
    setFocus(1 - focusIdx);
    activeView().focus();
  }

  // ---- Tabs -------------------------------------------------------------------------

  let dragId                = null;

  function renderTabs()       {
    if (!panes.length) return;
    const activeId = activeDoc().id;
    const otherId = splitOpen ? panes[1 - focusIdx]?.docId : null;
    const tabs = docs.map((d) => {
      const x = el('button', { class: 'ap-tab-x', text: '×', attrs: { type: 'button', tabindex: -1, title: 'Close (Ctrl+W)', 'aria-label': `Close ${d.name}` } });
      const tab = el(
        'div',
        {
          class: `ap-tab${d.id === activeId ? ' is-active' : ''}${d.id === otherId ? ' is-other' : ''}${d.dirty ? ' is-dirty' : ''}${d.readOnly ? ' is-readonly' : ''}`,
          attrs: { role: 'tab', draggable: 'true', title: d.path ?? d.name, 'aria-selected': d.id === activeId ? 'true' : 'false' },
        },
        el('span', { class: 'ap-tab-dot', attrs: { 'aria-hidden': 'true', title: d.dirty ? 'Unsaved changes' : '' } }),
        el('span', { class: 'ap-tab-name', text: d.name }),
        x,
      );
      x.addEventListener('mousedown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        void closeDoc(d);
      });
      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          return;
        }
        if (e.button === 0) activate(d);
      });
      tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeDoc(d);
        }
      });
      tab.addEventListener('dblclick', (e) => e.stopPropagation());
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        menuBar.context(tabContextMenu(d), e.clientX, e.clientY);
      });
      tab.addEventListener('dragstart', (e) => {
        dragId = d.id;
        e.dataTransfer?.setData('application/x-archpad-tab', d.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        tab.classList.add('is-dragging');
      });
      tab.addEventListener('dragend', () => {
        dragId = null;
        tab.classList.remove('is-dragging');
        tabBar.querySelectorAll('.drop-before, .drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
      });
      tab.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        tab.classList.toggle('drop-before', before);
        tab.classList.toggle('drop-after', !before);
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after'));
      tab.addEventListener('drop', (e) => {
        if (!dragId) return;
        e.preventDefault();
        e.stopPropagation();
        const moving = byId(dragId);
        if (!moving || moving === d) return;
        const r = tab.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        docs.splice(docs.indexOf(moving), 1);
        docs.splice(docs.indexOf(d) + (before ? 0 : 1), 0, moving);
        renderTabs();
        scheduleSession();
      });
      return tab;
    });
    const plus = el('button', { class: 'ap-tab-new', text: '+', attrs: { type: 'button', title: 'New (Ctrl+N)', 'aria-label': 'New document' }, on: { click: () => void exec('file.new') } });
    replace(tabBar, ...tabs, plus);
    tabBar.querySelector('.ap-tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  tabBar.addEventListener('dblclick', (e) => {
    if (e.target === tabBar) void exec('file.new');
  });
  tabBar.addEventListener('wheel', (e) => {
    if (e.deltaY && !e.ctrlKey) {
      tabBar.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // ---- Status bar, title, messages ----------------------------------------------

  let statusFrame = 0;
  function scheduleStatus()       {
    if (statusFrame) return;
    // A timer rather than requestAnimationFrame: rAF stalls in a background window, and the title and status must still follow.
    statusFrame = window.setTimeout(() => {
      statusFrame = 0;
      updateStatus();
    }, 16);
  }

  function updateStatus()       {
    if (!panes.length) return;
    const doc = activeDoc();
    const state = activeView().state;
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    const col = visualColumn(line.text.slice(0, main.head - line.from), settings.tabSize) + 1;
    let selChars = 0;
    let selLines = 0;
    for (const r of state.selection.ranges) {
      if (r.empty) continue;
      selChars += r.to - r.from;
      selLines += state.doc.lineAt(r.to).number - state.doc.lineAt(r.from).number + 1;
    }
    sLen.textContent = `length : ${state.doc.length.toLocaleString()}    lines : ${state.doc.lines.toLocaleString()}`;
    sPos.textContent = `Ln : ${line.number.toLocaleString()}    Col : ${col}    Pos : ${(main.head + 1).toLocaleString()}    Sel : ${selChars.toLocaleString()} | ${selLines.toLocaleString()}${state.selection.ranges.length > 1 ? `    (${state.selection.ranges.length} cursors)` : ''}`;
    sEol.textContent = EOL_LABELS[doc.eol];
    sEnc.textContent = ENCODING_LABELS[doc.encoding];
    sLang.textContent = languageLabel(doc.language);
    sIns.textContent = doc.readOnly ? 'READ' : overwrite ? 'OVR' : 'INS';
    sRec.hidden = !recorder.recording;
  }

  let lastTitle = '';
  function updateTitle()       {
    if (!panes.length) return;
    const doc = activeDoc();
    const title = `${doc.dirty ? '*' : ''}${doc.name} - ArchPad`;
    if (title !== lastTitle) {
      lastTitle = title;
      try {
        host.setTitle(title);
      } catch {
        // A title is cosmetic.
      }
    }
  }

  function refreshUi()       {
    renderTabs();
    updateStatus();
    updateTitle();
  }

  let notifyTimer = 0;
  function notify(message        , kind                   = 'info')       {
    sMsg.textContent = message;
    sMsg.classList.toggle('is-error', kind === 'error' && !!message);
    sMsg.title = message;
    clearTimeout(notifyTimer);
    if (message) notifyTimer = window.setTimeout(() => (sMsg.textContent = ''), kind === 'error' ? 12000 : 6000);
  }

  function showPanel(title        , body                      )       {
    panelTitle.textContent = title;
    replace(panelBody, typeof body === 'string' ? el('pre', { class: 'ap-pre', text: body }) : body);
    panel.hidden = false;
  }
  function hidePanel()       {
    panel.hidden = true;
    activeView()?.focus();
  }
  panelGrip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    const move = (ev              )       => {
      const h = Math.max(80, Math.min(root.getBoundingClientRect().height - 160, startH + startY - ev.clientY));
      panel.style.height = `${h}px`;
    };
    const up = ()       => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  function stepResult(dir        )       {
    const rows = [...panelBody.querySelectorAll             ('.ap-hit')];
    if (!rows.length) {
      notify('No search results. Use Find All in the Find dialog (Ctrl+F).', 'error');
      return;
    }
    panel.hidden = false;
    const at = rows.findIndex((r) => r.classList.contains('is-current'));
    const next = rows[(at + dir + rows.length) % rows.length] ;
    next.click();
    next.scrollIntoView({ block: 'nearest' });
  }

  // ---- View updates ---------------------------------------------------------------

  function onViewUpdate(u     )       {
    const pane = panes.find((p) => p.view === u.view);
    if (!pane) return;
    const doc = byId(pane.docId);
    if (!doc) return;
    if (u.docChanged) {
      refreshDirty(doc, u.state);
      scheduleSession();
      // Pasting into an empty new tab: find out what it is, as the toolkit's generators produce configs.
      if (doc.untitled && !doc.languageLocked && doc.language === 'text' && u.startState.doc.length === 0 && u.state.doc.length > 0) {
        const guess = detectFromContent(u.state.doc.sliceString(0, 65536), doc.name);
        if (guess) setTimeout(() => setLanguage(doc, guess, false), 0);
      }
    }
    if (pane === activePane() && (u.docChanged || u.selectionSet || u.focusChanged || u.transactions.length)) scheduleStatus();
  }

  // ---- Settings --------------------------------------------------------------------

  function applySettings(save = true)       {
    root.classList.toggle('ap-theme-dark', settings.theme === 'dark');
    root.classList.toggle('ap-theme-light', settings.theme === 'light');
    root.style.setProperty('--ap-font-size', `${settings.fontSize}px`);
    root.style.setProperty('--ap-tab-ch', String(settings.tabSize));
    for (const p of livePanes()) {
      const d = byId(p.docId);
      if (d) p.view.dispatch({ effects: reconfigureEffects(d) });
    }
    if (save) saveJson(SETTINGS_KEY, settings);
    updateStatus();
  }

  function toggleSetting(key                                                          )       {
    settings[key] = !settings[key];
    applySettings();
  }

  function zoom(step        )       {
    settings.fontSize = step === 0 ? DEFAULT_SETTINGS.fontSize : Math.max(6, Math.min(48, settings.fontSize + step));
    applySettings();
    notify(`Zoom: ${Math.round((settings.fontSize / DEFAULT_SETTINGS.fontSize) * 100)}%`);
  }

  // ---- Files ----------------------------------------------------------------------

  async function openFile(file            , askBinary = true)                      {
    const existing = docs.find((d) => (file.path && d.path === file.path) || (file.handle !== undefined && file.handle !== null && d.handle === file.handle));
    if (existing) return existing;
    if (askBinary && looksBinary(file.bytes)) {
      const ok = await confirmDialog(root, 'Open', `"${file.name}" looks like a binary file. Open it as text anyway?`, 'Open as text');
      if (!ok) return null;
    }
    const decoded = decodeFile(file.bytes, settings.defaultEol);
    const doc = createDoc({
      name: file.name,
      path: file.path,
      handle: file.handle,
      lastModified: file.lastModified,
      text: decoded.text,
      encoding: decoded.encoding,
      eol: decoded.eol,
      language: detectLanguage(file.path ?? file.name, decoded.text),
      bytes: file.bytes,
    });
    insertDoc(doc);
    if (decoded.mixedEol) notify(`${file.name} mixes line endings; it will be saved with ${EOL_LABELS[decoded.eol]}.`);
    addRecent(doc);
    return doc;
  }

  async function openFiles(files                       )                 {
    const pristine = panes.length ? activeDoc() : null;
    const opened        = [];
    for (const f of files) {
      try {
        const d = await openFile(f);
        if (d) opened.push(d);
      } catch (err) {
        notify(`Could not open ${f.name}: ${errorText(err)}`, 'error');
      }
    }
    const last = opened[opened.length - 1];
    if (last) {
      activate(last);
      // Notepad++ replaces the empty "new 1" it starts with.
      if (pristine && isPristine(pristine) && !opened.includes(pristine) && docs.length > 1) removeDoc(pristine, false);
    }
    scheduleSession();
    return opened;
  }

  async function openDialogFiles()                {
    try {
      const files = await host.openFiles();
      if (files.length) await openFiles(files);
    } catch (err) {
      notify(`Open failed: ${errorText(err)}`, 'error');
    }
  }

  async function saveDoc(doc     , mode                         = 'save')                   {
    const state = stateOf(doc);
    const text         = state.doc.toString();
    const bad = unmappableCount(text, doc.encoding);
    if (bad && !(await confirmDialog(root, 'Save', `${plural(bad, 'character')} cannot be written in ${ENCODING_LABELS[doc.encoding]} and will be saved as "?". Save anyway?`, 'Save anyway'))) return false;
    const request = { name: doc.name, path: doc.path, handle: doc.handle, bytes: encodeFile(text, doc.encoding, doc.eol) };
    let result;
    try {
      result = mode === 'save' && !doc.untitled ? await host.save(request) : await host.saveAs(request);
    } catch (err) {
      notify(`Save failed: ${errorText(err)}`, 'error');
      return false;
    }
    if (!result) return false;
    if (mode === 'copy') {
      notify(`Saved a copy as ${result.path ?? result.name}`);
      return true;
    }
    const wasUntitled = doc.untitled;
    const renamed = result.name !== doc.name;
    doc.name = result.name;
    doc.path = result.path;
    doc.handle = result.handle;
    doc.untitled = false;
    doc.savedDoc = state.doc;
    doc.metaDirty = false;
    doc.bytes = undefined;
    if (!doc.languageLocked && (renamed || wasUntitled)) {
      const lang = detectLanguage(doc.path ?? doc.name, text);
      if (lang !== doc.language) setLanguage(doc, lang, false);
    }
    refreshDirty(doc);
    addRecent(doc);
    refreshUi();
    scheduleSession();
    notify(`Saved ${doc.path ?? doc.name}`);
    return true;
  }

  async function saveAll()                {
    let n = 0;
    for (const d of [...docs]) {
      if (!d.dirty) continue;
      activate(d, false);
      if (!(await saveDoc(d))) {
        notify('Save All stopped: a save was cancelled or failed.', 'error');
        return;
      }
      n++;
    }
    notify(n ? `Saved ${plural(n, 'document')}` : 'Nothing to save');
  }

  async function reloadDoc(doc     )                {
    if (doc.untitled) {
      notify('This document has never been saved; there is nothing to reload.', 'error');
      return;
    }
    if (doc.dirty && !(await confirmDialog(root, 'Reload', `Reload "${doc.name}" from disk? Unsaved changes will be lost.`, 'Reload'))) return;
    let file                    = null;
    try {
      file = host.reload ? await host.reload({ path: doc.path, handle: doc.handle }) : null;
    } catch (err) {
      notify(`Reload failed: ${errorText(err)}`, 'error');
      return;
    }
    if (!file) {
      notify('This file cannot be re-read from here (no file handle). Open it again instead.', 'error');
      return;
    }
    const decoded = decodeFile(file.bytes, doc.eol);
    doc.encoding = decoded.encoding;
    doc.eol = decoded.eol;
    doc.metaDirty = false;
    doc.lastModified = file.lastModified;
    const state = stateOf(doc);
    applyToDoc(doc, { changes: { from: 0, to: state.doc.length, insert: decoded.text }, effects: setEol.of(doc.eol), selection: { anchor: Math.min(state.selection.main.head, decoded.text.length) } });
    doc.savedDoc = stateOf(doc).doc;
    doc.bytes = file.bytes;
    refreshDirty(doc);
    refreshUi();
    notify(`Reloaded ${doc.name}`);
  }

  function toSessionDoc(doc     )             {
    const state = stateOf(doc);
    return {
      id: doc.id,
      name: doc.name,
      path: doc.path,
      handle: doc.handle,
      lastModified: doc.lastModified,
      untitled: doc.untitled,
      encoding: doc.encoding,
      eol: doc.eol,
      language: doc.language,
      languageLocked: doc.languageLocked,
      text: state.doc.toString(),
      savedText: doc.dirty ? doc.savedDoc.toString() : undefined,
      metaDirty: doc.metaDirty || undefined,
      pinned: doc.pinned,
      readOnly: doc.readOnly,
      anchor: state.selection.main.anchor,
      head: state.selection.main.head,
      bookmarks: bookmarkedLines(state),
    };
  }

  function fromSessionDoc(s            , keepId = true)      {
    return createDoc({ ...s, id: keepId ? s.id : undefined, text: s.text ?? '' });
  }

  /** Take a document out; the panes showing it move to a neighbour. No questions asked. */
  function removeDoc(doc     , remember = true)       {
    if (compare) closeCompare();
    const idx = docs.indexOf(doc);
    if (idx < 0) return;
    if (remember) {
      closedStack.push(toSessionDoc(doc));
      if (closedStack.length > MAX_CLOSED) closedStack.shift();
    }
    docs.splice(idx, 1);
    for (const pane of [...livePanes()].reverse()) {
      if (pane.docId !== doc.id) continue;
      const other = livePanes().find((p) => p !== pane);
      const candidates = docs.filter((d) => !other || other.docId !== d.id);
      const replacement = candidates.find((d) => docs.indexOf(d) >= idx) ?? candidates[candidates.length - 1];
      if (replacement) showDoc(pane, replacement);
      else if (pane === panes[1]) closeSplit();
      else showDoc(pane, newUntitled());
    }
    refreshUi();
    scheduleSession();
  }

  async function closeDoc(doc     , ask = true)                   {
    if (ask && doc.dirty) {
      activate(doc);
      const choice = await saveChangesDialog(root, doc.name);
      if (choice === 'cancel') return false;
      if (choice === 'save' && !(await saveDoc(doc))) return false;
    }
    removeDoc(doc);
    activeView().focus();
    return true;
  }

  async function closeMany(list                )                {
    for (const d of list) {
      if (!docs.includes(d)) continue;
      if (!(await closeDoc(d))) return;
    }
  }

  function restoreClosed()       {
    const s = closedStack.pop();
    if (!s) {
      notify('No closed document to restore.');
      return;
    }
    const existing = docs.find((d) => (s.path && d.path === s.path) || d.id === s.id);
    if (existing) {
      activate(existing);
      return;
    }
    const doc = fromSessionDoc(s, false);
    insertDoc(doc);
    activate(doc);
    scheduleSession();
  }

  function addRecent(doc     )       {
    if (doc.untitled || (!doc.path && !doc.handle)) return;
    const key = doc.path ?? doc.name;
    recent = [{ name: doc.name, path: doc.path, handle: doc.handle }, ...recent.filter((r) => (r.path ?? r.name) !== key)].slice(0, MAX_RECENT);
    void saveRecent(recent).catch(() => undefined);
  }

  async function openRecent(r            )                {
    const open = docs.find((d) => (r.path && d.path === r.path) || (r.handle && d.handle === r.handle));
    if (open) {
      activate(open);
      return;
    }
    let file                    = null;
    try {
      file = host.reload ? await host.reload({ path: r.path, handle: r.handle }) : null;
    } catch {
      file = null;
    }
    if (!file) {
      notify(`${r.path ?? r.name} can no longer be opened from here; removed from the list.`, 'error');
      recent = recent.filter((x) => x !== r);
      void saveRecent(recent).catch(() => undefined);
      return;
    }
    await openFiles([{ ...file, name: file.name || r.name, path: file.path ?? r.path, handle: file.handle ?? r.handle }]);
  }

  // ---- Sessions ---------------------------------------------------------------------

  let sessionTimer = 0;
  function scheduleSession()       {
    if (!restored) return;
    clearTimeout(sessionTimer);
    sessionTimer = window.setTimeout(() => void persistSession(false), 800);
  }

  function sessionData()              {
    return {
      v: 1,
      savedAt: Date.now(),
      docs: docs.map(toSessionDoc),
      active: panes.length ? activeDoc().id : null,
      split: splitOpen ? panes[1]?.docId ?? null : null,
    };
  }

  async function persistSession(sync         )                {
    if (!restored) return;
    clearTimeout(sessionTimer);
    try {
      await saveSession(sessionData(), sync);
    } catch {
      // Storage refused: the documents are still open, only the restore is lost.
    }
  }

  async function restoreSession()                {
    try {
      const data = await loadSession();
      if (data && data.docs.length) {
        const placeholder = docs.length === 1 && isPristine(docs[0] ) ? docs[0]  : null;
        const known = new Set(docs.map((d) => d.id));
        const back = data.docs.filter((s) => !known.has(s.id)).map((s) => fromSessionDoc(s));
        docs.unshift(...back);
        if (placeholder) {
          const active = byId(data.active) ?? back[0];
          if (active) activate(active, false);
          removeDoc(placeholder, false);
          const split = byId(data.split);
          if (split && split !== activeDoc()) {
            openSplit(split);
            setFocus(0);
          }
        }
      }
    } catch {
      // A broken session must not stop the editor.
    }
    restored = true;
    try {
      recent = await loadRecent();
    } catch {
      recent = [];
    }
    refreshUi();
    try {
      host.onOpenRequest((files) => void openFiles(files));
    } catch {
      // A host without outside requests.
    }
  }

  // ---- Editing helpers ----------------------------------------------------------------

  function withView(fn                         )             {
    return () => {
      const view = activeView();
      fn(view);
      view.focus();
    };
  }

  function guardWritable(view      )          {
    if (view.state.readOnly) {
      notify('This document is read-only (Edit › Set Read-Only).', 'error');
      return false;
    }
    return true;
  }

  /** The selected lines, or the whole document when nothing is selected. */
  function lineRange(state       , wholeWhenEmpty = true)                               {
    const sel = state.selection.main;
    if (sel.empty && wholeWhenEmpty) return { from: 0, to: state.doc.length };
    const first = state.doc.lineAt(sel.from);
    let last = state.doc.lineAt(sel.to);
    if (last.number > first.number && sel.to === last.from) last = state.doc.line(last.number - 1);
    return { from: first.from, to: last.to };
  }

  function applyLines(fn                               , wholeWhenEmpty = true, label = '')       {
    const view = activeView();
    if (!guardWritable(view)) return;
    const state = view.state;
    const range = lineRange(state, wholeWhenEmpty);
    const text         = state.sliceDoc(range.from, range.to);
    const out = fn(text.split('\n')).join('\n');
    if (out === text) {
      notify(`${label || 'Line operation'}: nothing to change`);
      view.focus();
      return;
    }
    const sel = state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: out },
      selection: sel.empty ? { anchor: Math.min(sel.head, range.from + out.length) } : { anchor: range.from, head: range.from + out.length },
      scrollIntoView: true,
      userEvent: 'input',
    });
    view.focus();
  }

  function convertCaseCmd(mode              )       {
    const view = activeView();
    if (!guardWritable(view)) return;
    const state = view.state;
    const changes = state.selection.ranges.filter((r     ) => !r.empty).map((r     ) => ({ from: r.from, to: r.to, insert: ops.convertCase(state.sliceDoc(r.from, r.to), mode) }));
    if (!changes.length) {
      notify('Select the text to convert first.', 'error');
      return;
    }
    view.dispatch({ changes, userEvent: 'input' });
    view.focus();
  }

  function insertBlankLine(below         )       {
    const view = activeView();
    if (!guardWritable(view)) return;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const indent = /^[ \t]*/.exec(line.text) [0];
    if (below) view.dispatch({ changes: { from: line.to, insert: `\n${indent}` }, selection: { anchor: line.to + 1 + indent.length }, scrollIntoView: true, userEvent: 'input' });
    else view.dispatch({ changes: { from: line.from, insert: `${indent}\n` }, selection: { anchor: line.from + indent.length }, scrollIntoView: true, userEvent: 'input' });
    view.focus();
  }

  function transposeLine()       {
    const view = activeView();
    if (!guardWritable(view)) return;
    const state = view.state;
    const line = state.doc.lineAt(state.selection.main.head);
    if (line.number < 2) return;
    const prev = state.doc.line(line.number - 1);
    view.dispatch({ changes: { from: prev.from, to: line.to, insert: `${line.text}\n${prev.text}` }, selection: { anchor: prev.from + line.text.length + 1 + (state.selection.main.head - line.from) }, userEvent: 'input' });
    view.focus();
  }

  /** Ctrl+D: duplicate the line when nothing is selected, add the next occurrence when something is. */
  function ctrlD()       {
    const view = activeView();
    if (view.state.selection.main.empty) {
      if (guardWritable(view)) copyLineDown(view);
    } else selectNextOccurrence(view);
    view.focus();
  }

  // Keyboard column selection (Alt+Shift+arrows) from an anchor that stays put.
  let column                                                                                                = null;
  function columnExtend(dLine        , dCol        )       {
    const view = activeView();
    const state = view.state;
    const doc = state.doc;
    if (!column || column.sel !== state.selection) {
      const main = state.selection.main;
      const a = doc.lineAt(main.anchor);
      const h = doc.lineAt(main.head);
      column = { anchorLine: a.number, anchorCol: main.anchor - a.from, headLine: h.number, headCol: main.head - h.from, sel: null };
    }
    const c = column;
    c.headLine = Math.max(1, Math.min(doc.lines, c.headLine + dLine));
    const first = Math.min(c.anchorLine, c.headLine);
    const last = Math.max(c.anchorLine, c.headLine);
    let widest = 0;
    for (let n = first; n <= last; n++) widest = Math.max(widest, doc.line(n).length);
    c.headCol = Math.max(0, Math.min(Math.max(widest, c.anchorCol), c.headCol + dCol));
    const ranges = [];
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      ranges.push(EditorSelection.range(line.from + Math.min(c.anchorCol, line.length), line.from + Math.min(c.headCol, line.length)));
    }
    view.dispatch({ selection: EditorSelection.create(ranges, c.headLine - first), scrollIntoView: true, userEvent: 'select' });
    c.sel = view.state.selection;
  }

  async function columnEditor()                {
    const view = activeView();
    if (!guardWritable(view)) return;
    const mode = radioGroup('ap-col-mode', [{ label: 'Text to insert', value: 'text' }, { label: 'Number to insert', value: 'num' }]         , 'text');
    const text = textInput('');
    const initial = textInput('1', { inputmode: 'numeric' });
    const step = textInput('1', { inputmode: 'numeric' });
    const repeat = textInput('1', { inputmode: 'numeric' });
    const pad = selectInput([{ label: 'No padding', value: 'none' }, { label: 'Leading zeros', value: 'zeros' }, { label: 'Leading spaces', value: 'spaces' }]         , 'none');
    const format = radioGroup('ap-col-fmt', [{ label: 'Dec', value: 'dec' }, { label: 'Hex', value: 'hex' }, { label: 'Oct', value: 'oct' }, { label: 'Bin', value: 'bin' }]         , 'dec');
    const ok = await openDialog({
      host: root,
      title: 'Column / Multi-Selection Editor',
      body: [
        mode.row,
        field('Text', text),
        el('div', { class: 'ap-row' }, field('Initial number', initial), field('Increase by', step), field('Repeat', repeat)),
        el('div', { class: 'ap-row' }, field('Leading', pad), el('div', { class: 'ap-field' }, el('span', { text: 'Format' }), format.row)),
        el('small', { class: 'ap-hint', text: 'Inserts on every line of a column selection, or from the cursor line to the end of the document.' }),
      ],
      buttons: [
        { label: 'OK', value: true, primary: true },
        { label: 'Cancel', value: false },
      ],
      cancelValue: false,
    });
    if (!ok) return;
    const state = view.state;
    const doc = state.doc;
    const ranges = state.selection.ranges;
    let lineNos          ;
    let col        ;
    if (ranges.length > 1) {
      lineNos = [...new Set        (ranges.map((r     ) => doc.lineAt(r.from).number))].sort((a, b) => a - b);
      col = Math.max(...ranges.map((r     ) => r.from - doc.lineAt(r.from).from));
    } else {
      const r = ranges[0];
      const a = doc.lineAt(r.from);
      const b = doc.lineAt(r.to);
      if (r.empty) {
        lineNos = Array.from({ length: doc.lines - a.number + 1 }, (_, i) => a.number + i);
        col = r.from - a.from;
      } else {
        lineNos = Array.from({ length: b.number - a.number + 1 }, (_, i) => a.number + i);
        col = Math.min(r.anchor - doc.lineAt(r.anchor).from, r.head - doc.lineAt(r.head).from);
      }
    }
    let values          ;
    if (mode.value() === 'text') values = lineNos.map(() => text.value);
    else {
      const num = (s        , d        )         => (Number.isFinite(Number(s.trim())) && s.trim() !== '' ? Number(s.trim()) : d);
      values = ops.columnNumbers(lineNos.length, {
        initial: num(initial.value, 1),
        step: num(step.value, 1),
        repeat: num(repeat.value, 1),
        format: format.value(),
        pad: pad.value                               ,
        upperHex: true,
      });
    }
    const changes = lineNos.map((n, i) => {
      const line = doc.line(n);
      const v = values[i] ?? '';
      return line.length < col ? { from: line.to, insert: ' '.repeat(col - line.length) + v } : { from: line.from + col, insert: v };
    });
    view.dispatch({ changes, userEvent: 'input' });
    view.focus();
    notify(`Column Editor: ${plural(lineNos.length, 'line')}`);
  }

  async function splitLinesCmd()                {
    const answer = await promptDialog(root, 'Split Lines', 'Split lines longer than (characters):', '80');
    if (answer === null) return;
    const width = Number(answer);
    if (!Number.isFinite(width) || width < 1) {
      notify('Enter a width of at least 1.', 'error');
      return;
    }
    applyLines((l) => ops.splitLines(l, width), true, 'Split Lines');
  }

  /** Remove (or keep only) the bookmarked lines, then set bookmarks to what makes sense afterwards. */
  function filterLinesByBookmark(keepMarked         )       {
    const view = activeView();
    if (!guardWritable(view)) return;
    const state = view.state;
    const marked = new Set(bookmarkedLines(state));
    if (!marked.size) {
      notify('No bookmarks. Toggle one with Ctrl+F2 or Mark All with "Bookmark line".', 'error');
      return;
    }
    const kept           = [];
    for (let n = 1; n <= state.doc.lines; n++) if (marked.has(n) === keepMarked) kept.push(state.doc.line(n).text);
    const text = kept.join('\n');
    view.dispatch({ changes: { from: 0, to: state.doc.length, insert: text }, selection: { anchor: 0 }, userEvent: 'delete' });
    const after = view.state;
    view.dispatch({ effects: setBookmarks.of(keepMarked ? Array.from({ length: after.doc.lines }, (_, i) => after.doc.line(i + 1).from) : []) });
    view.focus();
    notify(`${plural(state.doc.lines - kept.length, 'line')} removed`);
  }

  function bookmarkedText(state       )         {
    return bookmarkedLines(state)
      .map((n        ) => state.doc.line(n).text)
      .join(EOL_TEXT_FOR(activeDoc()));
  }
  const EOL_TEXT_FOR = (doc     )         => (doc.eol === 'CRLF' ? '\r\n' : doc.eol === 'CR' ? '\r' : '\n');

  async function writeClipboard(text        , what        )                {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${what} copied to the clipboard`);
    } catch {
      notify('The clipboard is not available here.', 'error');
    }
  }

  function goToBookmark(dir        )       {
    const view = activeView();
    const lines = bookmarkedLines(view.state);
    if (!lines.length) {
      notify('No bookmarks (Ctrl+F2 toggles one).', 'error');
      return;
    }
    const cur = view.state.doc.lineAt(view.state.selection.main.head).number;
    const target = dir > 0 ? lines.find((n        ) => n > cur) ?? lines[0] : [...lines].reverse().find((n        ) => n < cur) ?? lines[lines.length - 1];
    const pos = view.state.doc.line(target).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    view.focus();
  }

  function inverseBookmarks()       {
    const view = activeView();
    const state = view.state;
    const marked = new Set(bookmarkedLines(state));
    const starts           = [];
    for (let n = 1; n <= state.doc.lines; n++) if (!marked.has(n)) starts.push(state.doc.line(n).from);
    view.dispatch({ effects: setBookmarks.of(starts) });
  }

  async function gotoLineDialog()                {
    const view = activeView();
    const state = view.state;
    const cur = state.doc.lineAt(state.selection.main.head);
    const mode = radioGroup('ap-goto', [{ label: 'Line', value: 'line' }, { label: 'Offset', value: 'offset' }]         , 'line');
    const input = textInput(String(cur.number), { inputmode: 'numeric' });
    const ok = await openDialog({
      host: root,
      title: 'Go To...',
      body: [mode.row, field(`Go to (you are on line ${cur.number.toLocaleString()} of ${state.doc.lines.toLocaleString()})`, input)],
      buttons: [
        { label: 'Go', value: true, primary: true },
        { label: 'Cancel', value: false },
      ],
      cancelValue: false,
    });
    if (!ok) {
      view.focus();
      return;
    }
    const n = parseInt(input.value.trim(), 10);
    if (!Number.isFinite(n)) {
      notify('Go To: enter a number.', 'error');
      return;
    }
    const pos = mode.value() === 'line' ? state.doc.line(Math.max(1, Math.min(state.doc.lines, n))).from : Math.max(0, Math.min(state.doc.length, n));
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    view.focus();
  }

  function jump(target            )       {
    const go = (doc     )       => {
      activate(doc);
      const view = activeView();
      const d = view.state.doc;
      const line = d.line(Math.max(1, Math.min(d.lines, target.line)));
      const from = line.from + Math.min(target.column, line.length);
      const to = Math.min(line.to, from + target.length);
      view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    };
    if (target.docId) {
      const doc = byId(target.docId);
      if (doc) go(doc);
      else notify('That document has been closed.', 'error');
      return;
    }
    if (target.file) {
      void openFiles([target.file]).then((opened) => {
        const doc = opened[0] ?? docs.find((d) => (target.file .path && d.path === target.file .path) || d.handle === target.file .handle);
        if (doc) go(doc);
      });
    }
  }

  function selectWordAtCursor(view      )         {
    const state = view.state;
    const sel = state.selection.main;
    if (!sel.empty) return state.sliceDoc(sel.from, sel.to);
    const range = state.wordAt(sel.head);
    if (!range) return '';
    view.dispatch({ selection: { anchor: range.from, head: range.to } });
    return state.sliceDoc(range.from, range.to);
  }

  function selectAndFind(backward         )       {
    const view = activeView();
    const word = selectWordAtCursor(view);
    if (!word || word.includes('\n')) {
      notify('Put the cursor on a word or select some text first.', 'error');
      return;
    }
    search.options = { ...search.options, query: word, mode: 'normal' };
    if (findInView(findHost, search.options, backward, true)) findHost.record({ t: 'find', o: search.options, backward, wrap: true });
    view.focus();
  }

  function findAgain(backward         )       {
    if (!search.options.query) {
      openFindDialog(findHost, 'find');
      return;
    }
    if (findInView(findHost, search.options, backward, search.wrap)) findHost.record({ t: 'find', o: search.options, backward, wrap: search.wrap });
    activeView().focus();
  }

  // ---- Encoding, EOL, language --------------------------------------------------------

  function encodeIn(doc     , encoding          )       {
    if (doc.encoding === encoding) return;
    const state = stateOf(doc);
    const wasClean = !doc.dirty;
    const current = convertEol(state.doc.toString(), doc.eol);
    const bytes = wasClean && doc.bytes ? doc.bytes : encode(current, doc.encoding);
    const text = decode(bytes, encoding);
    doc.encoding = encoding;
    if (text !== current) applyToDoc(doc, { changes: { from: 0, to: state.doc.length, insert: text }, selection: { anchor: 0 } });
    if (wasClean) {
      doc.savedDoc = stateOf(doc).doc;
      doc.bytes = bytes;
    }
    refreshDirty(doc);
    refreshUi();
    scheduleSession();
  }

  function convertTo(doc     , encoding          )       {
    if (doc.encoding === encoding) return;
    const bad = unmappableCount(stateOf(doc).doc.toString(), encoding);
    doc.encoding = encoding;
    doc.metaDirty = true;
    doc.bytes = undefined;
    refreshDirty(doc);
    refreshUi();
    scheduleSession();
    if (bad) notify(`${plural(bad, 'character')} cannot be written in ${ENCODING_LABELS[encoding]} and would be saved as "?".`, 'error');
  }

  function setEolFor(doc     , eol     )       {
    if (doc.eol === eol) return;
    doc.eol = eol;
    doc.metaDirty = true;
    applyToDoc(doc, { effects: setEol.of(eol) });
    refreshDirty(doc);
    refreshUi();
    scheduleSession();
  }

  function setLanguage(doc     , id        , locked = true)       {
    if (!docs.includes(doc)) return;
    doc.language = hasLanguage(id) ? id : 'text';
    doc.languageLocked = locked;
    applyToDoc(doc, { effects: cLang.reconfigure(languageExtension(doc.language)) });
    updateStatus();
    scheduleSession();
  }

  function setReadOnly(doc     , on         )       {
    doc.readOnly = on;
    applyToDoc(doc, { effects: cReadOnly.reconfigure(EditorState.readOnly.of(on)) });
    refreshUi();
    scheduleSession();
  }

  // ---- Search host ------------------------------------------------------------------

  const findHost           = {
    root,
    view: () => activeView(),
    docs: () => docs.map((d) => ({ id: d.id, name: d.path ?? d.name, text: stateOf(d).doc.toString() })),
    activeDocId: () => activeDoc().id,
    replaceInDoc: (id, edits) => {
      const d = byId(id);
      if (d && !d.readOnly) applyToDoc(d, { changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })), userEvent: 'input.replace' });
    },
    jump,
    showPanel: (title, body) => showPanel(title, body),
    notify: (message, kind) => notify(message, kind),
    openFolder: async () => {
      try {
        return await host.openFolder();
      } catch (err) {
        notify(`Open folder failed: ${errorText(err)}`, 'error');
        return null;
      }
    },
    openWithText: (file, text) => {
      void openFile(file, false).then((doc) => {
        if (!doc) return;
        setDocText(doc, text);
        refreshUi();
      });
    },
    record: (step) => recorder.add(step),
  };

  // ---- Macros -----------------------------------------------------------------------

  function toggleRecording()       {
    if (playing) return;
    if (recorder.recording) {
      lastMacro = recorder.stop();
      notify(lastMacro.length ? `Macro recorded: ${plural(lastMacro.length, 'step')}. Playback runs it; Save Current Recorded Macro keeps it.` : 'Nothing was recorded.');
    } else {
      recorder.start();
      notify('Recording a macro… (Ctrl+Shift+R stops)');
    }
    updateStatus();
    activeView().focus();
  }

  async function playStep(step           )                   {
    const view = activeView();
    switch (step.t) {
      case 'text':
        if (view.state.readOnly) return false;
        view.dispatch(view.state.replaceSelection(step.v), { scrollIntoView: true, userEvent: 'input.type' });
        return true;
      case 'key':
        runKey(view, step.k);
        return true;
      case 'cmd':
        await exec(step.id, true);
        return true;
      case 'find':
        return findInView(findHost, step.o, step.backward, step.wrap);
      case 'replaceAll':
        replaceAllInView(findHost, step.o, step.r, false);
        return true;
    }
  }

  async function playMacro(steps                      , times                )                {
    if (!steps.length) {
      notify('No macro to play. Record one with Ctrl+Shift+R.', 'error');
      return;
    }
    if (recorder.recording) {
      notify('Stop recording before playing a macro.', 'error');
      return;
    }
    playing = true;
    let runs = 0;
    const limit = times === 'eof' ? 100000 : Math.max(1, Math.floor(times));
    try {
      outer: while (runs < limit) {
        const view = activeView();
        const before = view.state.selection.main.head;
        const beforeLen = view.state.doc.length;
        for (const step of steps) {
          if (!(await playStep(step))) {
            if (runs === 0) notify('The macro stopped: a step could not run (search not found or read-only).', 'error');
            break outer;
          }
        }
        runs++;
        if (times === 'eof') {
          const v = activeView();
          const head = v.state.selection.main.head;
          if (head >= v.state.doc.length || (head === before && v.state.doc.length === beforeLen)) break;
        }
      }
    } finally {
      playing = false;
    }
    if (runs) notify(`Macro ran ${plural(runs, 'time')}`);
    activeView().focus();
  }

  async function runMultipleDialog()                {
    const choices = [{ label: 'Current recorded macro', value: -1 }, ...savedMacros.map((m, i) => ({ label: m.name, value: i }))];
    const which = selectInput(choices.map((c) => ({ label: c.label, value: String(c.value) })), '-1');
    const mode = radioGroup('ap-macro-times', [{ label: 'Run', value: 'n' }, { label: 'Run until the end of file', value: 'eof' }]         , 'n');
    const count = textInput('1', { inputmode: 'numeric' });
    const ok = await openDialog({
      host: root,
      title: 'Run a Macro Multiple Times',
      body: [field('Macro to run', which), mode.row, field('Times', count)],
      buttons: [
        { label: 'Run', value: true, primary: true },
        { label: 'Cancel', value: false },
      ],
      cancelValue: false,
    });
    if (!ok) return;
    const i = Number(which.value);
    const steps = i < 0 ? lastMacro : savedMacros[i]?.steps ?? [];
    const n = Math.max(1, Math.floor(Number(count.value) || 1));
    await playMacro(steps, mode.value() === 'eof' ? 'eof' : n);
  }

  async function saveMacro()                {
    if (!lastMacro.length) {
      notify('Record a macro first (Ctrl+Shift+R).', 'error');
      return;
    }
    const name = await promptDialog(root, 'Save Macro', 'Name:', `Macro ${savedMacros.length + 1}`);
    if (!name?.trim()) return;
    savedMacros = [...savedMacros.filter((m) => m.name !== name.trim()), { name: name.trim(), steps: lastMacro }];
    saveJson(MACROS_KEY, savedMacros);
    notify(`Saved macro "${name.trim()}"`);
  }

  async function deleteMacro()                {
    if (!savedMacros.length) {
      notify('There are no saved macros.', 'error');
      return;
    }
    const i = await pickDialog(root, 'Delete Macro', 'Saved macros:', savedMacros.map((m, k) => ({ label: m.name, value: k })));
    if (i === null) return;
    const name = savedMacros[i] .name;
    savedMacros = savedMacros.filter((_, k) => k !== i);
    saveJson(MACROS_KEY, savedMacros);
    notify(`Deleted macro "${name}"`);
  }

  function showMacro()       {
    const lists                = [];
    const block = (title        , steps                      )              =>
      el('div', {}, el('h4', { class: 'ap-h', text: title }), el('ol', { class: 'ap-list' }, ...steps.map((s) => el('li', { text: describeStep(s) }))));
    if (lastMacro.length) lists.push(block('Current recorded macro', lastMacro));
    for (const m of savedMacros) lists.push(block(m.name, m.steps));
    showPanel('Macros', lists.length ? el('div', { class: 'ap-panel-pad' }, ...lists) : 'No macros yet. Record one with Ctrl+Shift+R.');
  }

  // ---- Compare --------------------------------------------------------------------

  async function compareOpen()                {
    const a = activeDoc();
    let b                         = splitOpen ? byId(panes[1 - focusIdx]?.docId) : undefined;
    if (!b || b === a) {
      const others = docs.filter((d) => d !== a);
      if (!others.length) {
        notify('Open a second document to compare with.', 'error');
        return;
      }
      b = others.length === 1 ? others[0]  : await pickDialog(root, 'Compare', `Compare "${a.name}" with:`, others.map((d) => ({ label: d.path ?? d.name, value: d })));
      if (!b) return;
    }
    closeCompare();
    const docA = a;
    const docB = b;
    panesEl.hidden = true;
    compare = openCompare(
      main,
      { name: docA.name, text: stateOf(docA).doc.toString(), language: languageExtension(docA.language) },
      { name: docB.name, text: stateOf(docB).doc.toString(), language: languageExtension(docB.language) },
      {
        wrap: settings.wrap,
        notify: (m) => notify(m),
        onClose: (textA, textB) => {
          compare = null;
          panesEl.hidden = false;
          if (docs.includes(docA) && !docA.readOnly) setDocText(docA, textA);
          if (docs.includes(docB) && !docB.readOnly) setDocText(docB, textB);
          refreshUi();
          activeView().focus();
        },
      },
    );
  }

  function closeCompare()       {
    compare?.close();
  }

  // ---- Commands -------------------------------------------------------------------

  const commands = new Map             ();
  const order           = [];
  function def(id        , path        , label        , run               , extra                                                      = {})       {
    commands.set(id, { id, path, label, run, ...extra });
    order.push(id);
  }

  function commandContext()                 {
    return {
      getText: () => activeView().state.doc.toString(),
      getSelection: () => {
        const s = activeView().state;
        const m = s.selection.main;
        return s.sliceDoc(m.from, m.to);
      },
      replaceSelection: (text, o) => {
        const v = activeView();
        if (!guardWritable(v)) return;
        const m = v.state.selection.main;
        const whole = m.empty && !!o?.wholeWhenEmpty;
        const from = whole ? 0 : m.from;
        const to = whole ? v.state.doc.length : m.to;
        const normalized = text.replace(/\r\n?/g, '\n');
        v.dispatch({
          changes: { from, to, insert: text },
          selection: whole ? { anchor: Math.min(m.head, normalized.length) } : m.empty ? { anchor: from + normalized.length } : { anchor: from, head: from + normalized.length },
          scrollIntoView: true,
          userEvent: 'input',
        });
      },
      setText: (text) => {
        const v = activeView();
        if (!guardWritable(v)) return;
        setDocText(activeDoc(), text);
      },
      newDocument: (name, text, language) => api.newDocument(name, text, language),
      notify: (m, kind) => notify(m, kind),
      prompt: (label, initial) => promptDialog(root, 'ArchPad', label, initial ?? ''),
      showPanel: (title, body) => showPanel(title, body),
    };
  }

  const P = { file: 'File', edit: 'Edit', search: 'Search', view: 'View', enc: 'Encoding', lang: 'Language', tools: 'Tools', macro: 'Macro', win: 'Window', help: 'Help' };
  const sub = (a        , b        )         => `${a} › ${b}`;

  // File
  def('file.new', P.file, 'New', () => activate(newUntitled()), { shortcut: 'Ctrl+N' });
  def('file.open', P.file, 'Open…', () => openDialogFiles(), { shortcut: 'Ctrl+O', noRecord: true });
  def('file.reload', P.file, 'Reload from Disk', () => reloadDoc(activeDoc()), { enabled: () => !activeDoc().untitled });
  def('file.save', P.file, 'Save', () => saveDoc(activeDoc()), { shortcut: 'Ctrl+S' });
  def('file.saveAs', P.file, 'Save As…', () => saveDoc(activeDoc(), 'as'), { shortcut: 'Ctrl+Alt+S', noRecord: true });
  def('file.saveCopy', P.file, 'Save a Copy As…', () => saveDoc(activeDoc(), 'copy'), { noRecord: true });
  def('file.saveAll', P.file, 'Save All', () => saveAll(), { shortcut: 'Ctrl+Shift+S' });
  def('file.rename', P.file, 'Rename…', async () => {
    const doc = activeDoc();
    if (!doc.untitled) {
      notify('A saved file is renamed by saving it under the new name (Save As).');
      await saveDoc(doc, 'as');
      return;
    }
    const name = await promptDialog(root, 'Rename', 'New name:', doc.name);
    if (!name?.trim()) return;
    doc.name = name.trim();
    if (!doc.languageLocked) setLanguage(doc, detectLanguage(doc.name, stateOf(doc).doc.toString()), false);
    refreshUi();
    scheduleSession();
  }, { noRecord: true });
  def('file.close', P.file, 'Close', () => closeDoc(activeDoc()), { shortcut: 'Ctrl+W', keys: ['Ctrl+F4'] });
  def('file.closeAll', P.file, 'Close All', () => closeMany([...docs]), { shortcut: 'Ctrl+Shift+W' });
  def('file.closeOthers', sub(P.file, 'Close Multiple Documents'), 'Close All but Active Document', () => closeMany(docs.filter((d) => d !== activeDoc())));
  def('file.closeLeft', sub(P.file, 'Close Multiple Documents'), 'Close All to the Left', () => closeMany(docs.slice(0, docs.indexOf(activeDoc()))));
  def('file.closeRight', sub(P.file, 'Close Multiple Documents'), 'Close All to the Right', () => closeMany(docs.slice(docs.indexOf(activeDoc()) + 1)));
  def('file.closeUnchanged', sub(P.file, 'Close Multiple Documents'), 'Close All Unchanged', () => closeMany(docs.filter((d) => !d.dirty)));
  def('file.restoreClosed', P.file, 'Restore Recent Closed File', () => restoreClosed(), { shortcut: 'Ctrl+Shift+T' });
  def('file.openAllRecent', sub(P.file, 'Recent Files'), 'Open All Recent Files', async () => {
    for (const r of [...recent]) await openRecent(r);
  }, { noRecord: true });
  def('file.clearRecent', sub(P.file, 'Recent Files'), 'Empty Recent Files List', () => {
    recent = [];
    void saveRecent(recent).catch(() => undefined);
    notify('Recent files list emptied');
  }, { noRecord: true });

  // Edit
  def('edit.undo', P.edit, 'Undo', withView((v) => undo(v)), { shortcut: 'Ctrl+Z', showOnly: true });
  def('edit.redo', P.edit, 'Redo', withView((v) => redo(v)), { shortcut: 'Ctrl+Y', showOnly: true });
  def('edit.cut', P.edit, 'Cut', withView(() => document.execCommand('cut')), { shortcut: 'Ctrl+X', showOnly: true });
  def('edit.copy', P.edit, 'Copy', withView(() => document.execCommand('copy')), { shortcut: 'Ctrl+C', showOnly: true });
  def('edit.paste', P.edit, 'Paste', async () => {
    const view = activeView();
    if (!guardWritable(view)) return;
    try {
      const text = await navigator.clipboard.readText();
      view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input.paste' });
    } catch {
      notify('The browser blocked reading the clipboard; press Ctrl+V instead.', 'error');
    }
    view.focus();
  }, { shortcut: 'Ctrl+V', showOnly: true });
  def('edit.delete', P.edit, 'Delete', withView((v) => {
    if (!guardWritable(v)) return;
    const changes = v.state.selection.ranges.filter((r     ) => !r.empty).map((r     ) => ({ from: r.from, to: r.to }));
    if (changes.length) v.dispatch({ changes, userEvent: 'delete' });
  }), { shortcut: 'Del', showOnly: true });
  def('edit.selectAll', P.edit, 'Select All', withView((v) => selectAll(v)), { shortcut: 'Ctrl+A', showOnly: true });
  def('edit.copyPath', sub(P.edit, 'Copy to Clipboard'), 'Copy Current Full File Path', () => writeClipboard(activeDoc().path ?? activeDoc().name, 'Path'));
  def('edit.copyName', sub(P.edit, 'Copy to Clipboard'), 'Copy Current Filename', () => writeClipboard(activeDoc().name, 'File name'));
  def('edit.copyDir', sub(P.edit, 'Copy to Clipboard'), 'Copy Current Dir. Path', () => {
    const p = activeDoc().path;
    if (!p) {
      notify('The folder of this document is not known here.', 'error');
      return;
    }
    return writeClipboard(p.replace(/[\\/][^\\/]*$/, ''), 'Folder path');
  });
  def('edit.indent', sub(P.edit, 'Indent'), 'Increase Line Indent', withView((v) => guardWritable(v) && indentMore(v)), { shortcut: 'Tab', showOnly: true });
  def('edit.outdent', sub(P.edit, 'Indent'), 'Decrease Line Indent', withView((v) => guardWritable(v) && indentLess(v)), { shortcut: 'Shift+Tab', showOnly: true });

  const CASES                                             = [
    ['upper', 'UPPERCASE', 'Ctrl+Shift+U'],
    ['lower', 'lowercase', 'Ctrl+U'],
    ['proper', 'Proper Case', 'Alt+U'],
    ['proper-blend', 'Proper Case (blend)', 'Alt+Shift+U'],
    ['sentence', 'Sentence case', 'Ctrl+Alt+U'],
    ['sentence-blend', 'Sentence case (blend)', 'Ctrl+Alt+Shift+U'],
    ['invert', 'iNVERT cASE', 'Ctrl+Alt+I'],
    ['random', 'ranDOm CasE', 'Ctrl+Alt+R'],
  ];
  for (const [mode, label, shortcut] of CASES) def(`edit.case.${mode}`, sub(P.edit, 'Convert Case to'), label, () => convertCaseCmd(mode), shortcut ? { shortcut } : {});

  const LO = sub(P.edit, 'Line Operations');
  def('edit.duplicate', LO, 'Duplicate Current Line', withView((v) => guardWritable(v) && copyLineDown(v)), { shortcut: 'Ctrl+D', showOnly: true });
  def('edit.ctrlD', LO, 'Duplicate Line / Add Next Occurrence', () => ctrlD(), { shortcut: 'Ctrl+D', hidden: true });
  def('edit.deleteLine', LO, 'Delete Current Line', withView((v) => guardWritable(v) && deleteLine(v)), { shortcut: 'Ctrl+Shift+L' });
  def('edit.moveUp', LO, 'Move Up Current Line', withView((v) => guardWritable(v) && moveLineUp(v)), { shortcut: 'Ctrl+Shift+Up' });
  def('edit.moveDown', LO, 'Move Down Current Line', withView((v) => guardWritable(v) && moveLineDown(v)), { shortcut: 'Ctrl+Shift+Down' });
  def('edit.transpose', LO, 'Transpose Current Line', () => transposeLine(), { shortcut: 'Ctrl+T' });
  def('edit.removeDup', LO, 'Remove Duplicate Lines', () => applyLines(ops.removeDuplicates, true, 'Remove Duplicate Lines'));
  def('edit.removeConsecDup', LO, 'Remove Consecutive Duplicate Lines', () => applyLines(ops.removeConsecutiveDuplicates, true, 'Remove Consecutive Duplicates'));
  def('edit.split', LO, 'Split Lines…', () => splitLinesCmd(), { shortcut: 'Ctrl+I' });
  def('edit.join', LO, 'Join Lines', () => applyLines(ops.joinLines, false, 'Join Lines'), { shortcut: 'Ctrl+J' });
  def('edit.blankAbove', LO, 'Insert Blank Line Above Current', () => insertBlankLine(false), { shortcut: 'Ctrl+Alt+Enter' });
  def('edit.blankBelow', LO, 'Insert Blank Line Below Current', () => insertBlankLine(true), { shortcut: 'Ctrl+Alt+Shift+Enter' });
  def('edit.reverse', LO, 'Reverse Line Order', () => applyLines(ops.reverseLines, true, 'Reverse'));
  const SORTS                                    = [
    ['asc', 'Sort Lines Lexicographically Ascending'],
    ['desc', 'Sort Lines Lexicographically Descending'],
    ['asc-ci', 'Sort Lines Lex. Ascending Ignoring Case'],
    ['desc-ci', 'Sort Lines Lex. Descending Ignoring Case'],
    ['locale-asc', 'Sort Lines In Locale Order Ascending'],
    ['locale-desc', 'Sort Lines In Locale Order Descending'],
    ['num-asc', 'Sort Lines As Integers/Decimals Ascending'],
    ['num-desc', 'Sort Lines As Integers/Decimals Descending'],
    ['len-asc', 'Sort Lines By Length Ascending'],
    ['len-desc', 'Sort Lines By Length Descending'],
  ];
  for (const [mode, label] of SORTS) def(`edit.sort.${mode}`, LO, label, () => applyLines((l) => ops.sortLines(l, mode), true, 'Sort'));
  def('edit.removeEmpty', LO, 'Remove Empty Lines', () => applyLines(ops.removeEmptyLines, true, 'Remove Empty Lines'));
  def('edit.removeBlank', LO, 'Remove Empty Lines (Containing Blank characters)', () => applyLines(ops.removeBlankLines, true, 'Remove Blank Lines'));
  def('edit.squeeze', LO, 'Squeeze Runs of Blank Lines', () => applyLines(ops.squeezeBlankLines, true, 'Squeeze'));

  const CM_PATH = sub(P.edit, 'Comment/Uncomment');
  def('edit.toggleComment', CM_PATH, 'Toggle Single Line Comment', withView((v) => guardWritable(v) && toggleLineComment(v)), { shortcut: 'Ctrl+Q' });
  def('edit.comment', CM_PATH, 'Single Line Comment', withView((v) => guardWritable(v) && lineComment(v)), { shortcut: 'Ctrl+K' });
  def('edit.uncomment', CM_PATH, 'Single Line Uncomment', withView((v) => guardWritable(v) && lineUncomment(v)), { shortcut: 'Ctrl+Shift+K' });
  def('edit.blockComment', CM_PATH, 'Block Comment', withView((v) => guardWritable(v) && toggleBlockComment(v)), { shortcut: 'Ctrl+Shift+Q' });

  const BO = sub(P.edit, 'Blank Operations');
  def('edit.trimTrailing', BO, 'Trim Trailing Space', () => applyLines(ops.trimTrailing, true, 'Trim Trailing'));
  def('edit.trimLeading', BO, 'Trim Leading Space', () => applyLines(ops.trimLeading, true, 'Trim Leading'));
  def('edit.trimBoth', BO, 'Trim Leading and Trailing Space', () => applyLines(ops.trimBoth, true, 'Trim'));
  def('edit.eolToSpace', BO, 'EOL to Space', () => applyLines((l) => [l.join(' ')], true, 'EOL to Space'));
  def('edit.trimEolToSpace', BO, 'Trim Both and EOL to Space', () => applyLines((l) => [ops.trimBoth(l).filter(Boolean).join(' ')], true, 'Trim and join'));
  def('edit.tabToSpace', BO, 'TAB to Space', () => applyLines((l) => ops.tabsToSpaces(l, settings.tabSize), true, 'TAB to Space'));
  def('edit.spaceToTabAll', BO, 'Space to TAB (All)', () => applyLines((l) => ops.spacesToTabs(l, settings.tabSize), true, 'Space to TAB'));
  def('edit.spaceToTabLeading', BO, 'Space to TAB (Leading)', () => applyLines((l) => ops.spacesToTabs(l, settings.tabSize, true), true, 'Space to TAB'));

  const EOLS                 = ['CRLF', 'LF', 'CR'];
  for (const eol of EOLS) {
    def(`edit.eol.${eol}`, sub(P.edit, 'EOL Conversion'), `${EOL_LABELS[eol]}`, () => setEolFor(activeDoc(), eol), { checked: () => activeDoc().eol === eol, radio: true });
  }

  const MS = sub(P.edit, 'Multi-select');
  def('edit.multiNext', MS, 'Multi-select Next Occurrence', withView((v) => selectNextOccurrence(v)), { shortcut: 'Ctrl+D', showOnly: true });
  def('edit.multiAll', MS, 'Multi-select All Occurrences', withView((v) => selectSelectionMatches(v)), { shortcut: 'Ctrl+Shift+D' });
  def('edit.cursorAbove', MS, 'Add Cursor Above', withView((v) => addCursorAbove(v)), { shortcut: 'Ctrl+Alt+Up' });
  def('edit.cursorBelow', MS, 'Add Cursor Below', withView((v) => addCursorBelow(v)), { shortcut: 'Ctrl+Alt+Down' });
  def('edit.columnMode', P.edit, 'Column Mode…', () =>
    messageDialog(root, 'Column Mode', [
      el('p', { text: 'Column (rectangular) selection:' }),
      el('ul', {}, el('li', { text: 'Alt + drag with the mouse, or' }), el('li', { text: 'Alt + Shift + arrow keys.' })),
      el('p', { text: 'Then type to edit every line at once, or use the Column Editor (Alt+C) to insert text or incrementing numbers. Ctrl + click adds a cursor; Ctrl+D adds the next occurrence of the selection.' }),
    ]), { noRecord: true });
  def('edit.columnEditor', P.edit, 'Column Editor…', () => columnEditor(), { shortcut: 'Alt+C', noRecord: true });
  def('edit.colUp', MS, 'Column Select Up', () => columnExtend(-1, 0), { shortcut: 'Alt+Shift+Up', hidden: true });
  def('edit.colDown', MS, 'Column Select Down', () => columnExtend(1, 0), { shortcut: 'Alt+Shift+Down', hidden: true });
  def('edit.colLeft', MS, 'Column Select Left', () => columnExtend(0, -1), { shortcut: 'Alt+Shift+Left', hidden: true });
  def('edit.colRight', MS, 'Column Select Right', () => columnExtend(0, 1), { shortcut: 'Alt+Shift+Right', hidden: true });
  def('edit.readOnly', P.edit, 'Set Read-Only', () => setReadOnly(activeDoc(), !activeDoc().readOnly), { checked: () => activeDoc().readOnly });
  def('edit.overwrite', P.edit, 'Toggle Insert / Overwrite', () => {
    overwrite = !overwrite;
    updateStatus();
  }, { shortcut: 'Ins', hidden: true });

  // Search
  def('search.find', P.search, 'Find…', () => openFindDialog(findHost, 'find'), { shortcut: 'Ctrl+F', noRecord: true });
  def('search.findInFiles', P.search, 'Find in Files…', () => openFindDialog(findHost, 'files'), { shortcut: 'Ctrl+Shift+F', noRecord: true });
  def('search.next', P.search, 'Find Next', () => findAgain(false), { shortcut: 'F3', noRecord: true });
  def('search.prev', P.search, 'Find Previous', () => findAgain(true), { shortcut: 'Shift+F3', noRecord: true });
  def('search.selNext', P.search, 'Select and Find Next', () => selectAndFind(false), { shortcut: 'Ctrl+F3', noRecord: true });
  def('search.selPrev', P.search, 'Select and Find Previous', () => selectAndFind(true), { shortcut: 'Ctrl+Shift+F3', noRecord: true });
  def('search.replace', P.search, 'Replace…', () => openFindDialog(findHost, 'replace'), { shortcut: 'Ctrl+H', noRecord: true });
  def('search.results', P.search, 'Search Results Window', () => (panel.hidden ? (panelBody.childElementCount ? (panel.hidden = false) : notify('No results yet.')) : hidePanel()), { shortcut: 'F7', noRecord: true });
  def('search.nextResult', P.search, 'Next Search Result', () => stepResult(1), { shortcut: 'F4', noRecord: true });
  def('search.prevResult', P.search, 'Previous Search Result', () => stepResult(-1), { shortcut: 'Shift+F4', noRecord: true });
  def('search.goto', P.search, 'Go to…', () => gotoLineDialog(), { shortcut: 'Ctrl+G', noRecord: true });
  def('search.brace', P.search, 'Go to Matching Brace', withView((v) => cursorMatchingBracket(v)), { shortcut: 'Ctrl+B' });
  def('search.selectBrace', P.search, 'Select All In-between {} [] or ()', withView((v) => selectMatchingBracket(v)), { shortcut: 'Ctrl+Alt+B' });
  def('search.mark', P.search, 'Mark…', () => openFindDialog(findHost, 'mark'), { shortcut: 'Ctrl+M', noRecord: true });
  def('search.clearMarks', P.search, 'Clear All Marks', withView((v) => clearMarks(v)));
  const BM = sub(P.search, 'Bookmark');
  def('bm.toggle', BM, 'Toggle Bookmark', withView((v) => v.dispatch({ effects: toggleBookmark.of(v.state.selection.main.head) })), { shortcut: 'Ctrl+F2' });
  def('bm.next', BM, 'Next Bookmark', () => goToBookmark(1), { shortcut: 'F2' });
  def('bm.prev', BM, 'Previous Bookmark', () => goToBookmark(-1), { shortcut: 'Shift+F2' });
  def('bm.clear', BM, 'Clear All Bookmarks', withView((v) => v.dispatch({ effects: setBookmarks.of([]) })));
  def('bm.cut', BM, 'Cut Bookmarked Lines', async () => {
    const view = activeView();
    const text = bookmarkedText(view.state);
    if (!text && !bookmarkedLines(view.state).length) {
      notify('No bookmarks.', 'error');
      return;
    }
    await writeClipboard(text, 'Bookmarked lines');
    filterLinesByBookmark(false);
  });
  def('bm.copy', BM, 'Copy Bookmarked Lines', () => {
    const state = activeView().state;
    if (!bookmarkedLines(state).length) {
      notify('No bookmarks.', 'error');
      return;
    }
    return writeClipboard(bookmarkedText(state), 'Bookmarked lines');
  });
  def('bm.remove', BM, 'Remove Bookmarked Lines', () => filterLinesByBookmark(false));
  def('bm.removeUnmarked', BM, 'Remove Unmarked Lines', () => filterLinesByBookmark(true));
  def('bm.inverse', BM, 'Inverse Bookmark', () => inverseBookmarks());

  // View
  def('view.fullscreen', P.view, 'Toggle Full Screen Mode', () => toggleFullscreen(), { shortcut: 'F11', checked: () => root.classList.contains('is-fullscreen'), noRecord: true });
  def('view.wrap', P.view, 'Word Wrap', () => toggleSetting('wrap'), { checked: () => settings.wrap });
  const SS = sub(P.view, 'Show Symbol');
  def('view.whitespace', SS, 'Show Space and Tab', () => toggleSetting('whitespace'), { checked: () => settings.whitespace });
  def('view.eol', SS, 'Show End of Line', () => toggleSetting('eol'), { checked: () => settings.eol });
  def('view.allChars', SS, 'Show All Characters', () => {
    const on = !(settings.whitespace && settings.eol);
    settings.whitespace = on;
    settings.eol = on;
    applySettings();
  }, { checked: () => settings.whitespace && settings.eol });
  def('view.guides', SS, 'Show Indent Guide', () => toggleSetting('guides'), { checked: () => settings.guides });
  def('view.lineNumbers', P.view, 'Show Line Numbers', () => toggleSetting('lineNumbers'), { checked: () => settings.lineNumbers });
  const ZM = sub(P.view, 'Zoom');
  def('view.zoomIn', ZM, 'Zoom In (Ctrl+Mouse Wheel Up)', () => zoom(1), { shortcut: 'Ctrl+=', keys: ['Ctrl+Shift+=', 'Ctrl+Num+'] });
  def('view.zoomOut', ZM, 'Zoom Out (Ctrl+Mouse Wheel Down)', () => zoom(-1), { shortcut: 'Ctrl+-', keys: ['Ctrl+Num-'] });
  def('view.zoomReset', ZM, 'Restore Default Zoom', () => zoom(0), { shortcut: 'Ctrl+0', keys: ['Ctrl+Num/'] });
  const TH = sub(P.view, 'Theme');
  const THEMES                             = [
    ['auto', 'Follow the toolkit'],
    ['dark', 'Dark'],
    ['light', 'Light'],
  ];
  for (const [theme, label] of THEMES) {
    def(`view.theme.${theme}`, TH, label, () => {
      settings.theme = theme;
      applySettings();
    }, { checked: () => settings.theme === theme, radio: true });
  }
  def('view.foldAll', P.view, 'Fold All', withView((v) => foldAll(v)), { shortcut: 'Alt+0' });
  def('view.unfoldAll', P.view, 'Unfold All', withView((v) => unfoldAll(v)), { shortcut: 'Alt+Shift+0' });
  def('view.foldCurrent', P.view, 'Fold Current Level', withView((v) => foldCode(v)), { shortcut: 'Ctrl+Alt+F' });
  def('view.unfoldCurrent', P.view, 'Unfold Current Level', withView((v) => unfoldCode(v)), { shortcut: 'Ctrl+Alt+Shift+F' });
  def('view.moveOther', P.view, 'Move to Other View', () => moveToOtherView());
  def('view.closeOther', P.view, 'Close Other View', () => closeSplit(), { enabled: () => splitOpen });
  def('view.switchView', P.view, 'Switch to Other View', () => {
    if (!splitOpen) return;
    setFocus(1 - focusIdx);
    activeView().focus();
  }, { shortcut: 'F8', enabled: () => splitOpen });
  def('view.tabSettings', P.view, 'Tab Settings…', async () => {
    const size = textInput(String(settings.tabSize), { inputmode: 'numeric' });
    const spaces = checkbox('Replace by space', settings.useSpaces);
    const ok = await openDialog({
      host: root,
      title: 'Tab Settings',
      body: [field('Tab size', size), spaces.row],
      buttons: [
        { label: 'OK', value: true, primary: true },
        { label: 'Cancel', value: false },
      ],
      cancelValue: false,
    });
    if (!ok) return;
    const n = Math.round(Number(size.value));
    settings.tabSize = Number.isFinite(n) && n >= 1 && n <= 16 ? n : settings.tabSize;
    settings.useSpaces = spaces.input.checked;
    applySettings();
  }, { noRecord: true });
  def('view.summary', P.view, 'Summary…', () => {
    const doc = activeDoc();
    const state = stateOf(doc);
    const text         = state.doc.toString();
    const sel = state.selection.ranges.reduce((n        , r     ) => n + r.to - r.from, 0);
    showPanel(
      'Summary',
      table([
        { name: 'Name', value: doc.name },
        { name: 'Path', value: doc.path ?? (doc.untitled ? '(not saved yet)' : '(opened in the browser; the full path is not visible here)') },
        { name: 'Language', value: languageLabel(doc.language) },
        { name: 'Encoding', value: ENCODING_LABELS[doc.encoding] },
        { name: 'Line ending', value: EOL_LABELS[doc.eol] },
        { name: 'Characters (without line endings)', value: (text.length - (state.doc.lines - 1)).toLocaleString() },
        { name: 'Words', value: (text.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0).toLocaleString() },
        { name: 'Lines', value: state.doc.lines.toLocaleString() },
        { name: 'Document length (bytes on save)', value: encodeFile(text, doc.encoding, doc.eol).length.toLocaleString() },
        { name: 'Selected characters', value: sel.toLocaleString() },
        { name: 'Modified', value: doc.dirty ? 'Yes (unsaved changes)' : 'No' },
      ]),
    );
  }, { noRecord: true });

  // Encoding
  for (const enc of ALL_ENCODINGS) {
    def(`enc.in.${enc}`, P.enc, `Encode in ${ENCODING_LABELS[enc]}`, () => encodeIn(activeDoc(), enc), { checked: () => activeDoc().encoding === enc, radio: true });
  }
  for (const enc of ALL_ENCODINGS) {
    def(`enc.to.${enc}`, P.enc, `Convert to ${ENCODING_LABELS[enc]}`, () => convertTo(activeDoc(), enc));
  }

  // Language
  def('lang.auto', P.lang, 'Auto-detect', () => {
    const doc = activeDoc();
    const id = detectLanguage(doc.path ?? doc.name, stateOf(doc).doc.toString());
    setLanguage(doc, id, false);
    notify(`Language: ${languageLabel(id)}`);
  });
  for (const l of LANGUAGES) {
    def(`lang.${l.id}`, P.lang, l.label, () => setLanguage(activeDoc(), l.id, true), { checked: () => activeDoc().language === l.id, radio: true });
  }

  // Tools (the core's own) and the host's tool commands
  const CP = sub(P.tools, 'Compare');
  def('compare.open', CP, 'Compare with…', () => compareOpen(), { shortcut: 'Ctrl+Alt+C', noRecord: true });
  def('compare.next', CP, 'Next Difference', () => compare?.next() ?? notify('No comparison is open (Ctrl+Alt+C).', 'error'), { shortcut: 'Ctrl+PageDown', showOnly: true, noRecord: true });
  def('compare.prev', CP, 'Previous Difference', () => compare?.previous() ?? notify('No comparison is open (Ctrl+Alt+C).', 'error'), { shortcut: 'Ctrl+PageUp', showOnly: true, noRecord: true });
  def('compare.close', CP, 'Close Compare', () => closeCompare(), { shortcut: 'Ctrl+Alt+X', enabled: () => !!compare, noRecord: true });

  const toolCommands                     = options.commands ?? [];
  for (const t of toolCommands) {
    if (commands.has(t.id)) continue;
    def(t.id, t.group ? sub(t.menu, t.group) : t.menu, t.label, () => t.run(commandContext()), t.shortcut ? { shortcut: t.shortcut } : {});
  }

  // Macro
  def('macro.record', P.macro, 'Start Recording', () => toggleRecording(), {
    shortcut: 'Ctrl+Shift+R',
    noRecord: true,
    dynamicLabel: () => (recorder.recording ? 'Stop Recording' : 'Start Recording'),
  });
  def('macro.play', P.macro, 'Playback', () => playMacro(lastMacro, 1), { noRecord: true, enabled: () => lastMacro.length > 0 && !recorder.recording });
  def('macro.save', P.macro, 'Save Current Recorded Macro…', () => saveMacro(), { noRecord: true, enabled: () => lastMacro.length > 0 });
  def('macro.runMulti', P.macro, 'Run a Macro Multiple Times…', () => runMultipleDialog(), { noRecord: true });
  def('macro.show', P.macro, 'Show Macros', () => showMacro(), { noRecord: true });
  def('macro.delete', P.macro, 'Delete Saved Macro…', () => deleteMacro(), { noRecord: true, enabled: () => savedMacros.length > 0 });

  // Window
  def('win.next', P.win, 'Next Tab', () => cycleTab(1), { shortcut: 'Ctrl+Tab', noRecord: true });
  def('win.prev', P.win, 'Previous Tab', () => cycleTab(-1), { shortcut: 'Ctrl+Shift+Tab', noRecord: true });
  def('win.nextOrDiff', P.win, 'Next Tab / Next Difference', () => (compare ? compare.next() : cycleTab(1)), { shortcut: 'Ctrl+PageDown', hidden: true, noRecord: true });
  def('win.prevOrDiff', P.win, 'Previous Tab / Previous Difference', () => (compare ? compare.previous() : cycleTab(-1)), { shortcut: 'Ctrl+PageUp', hidden: true, noRecord: true });
  def('win.sort', P.win, 'Sort Tabs by Name', () => {
    docs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    renderTabs();
    scheduleSession();
  }, { noRecord: true });
  def('win.list', P.win, 'Windows…', async () => {
    const d = await pickDialog(root, 'Windows', 'Open documents:', docs.map((x) => ({ label: `${x.dirty ? '*' : ''}${x.path ?? x.name}`, value: x })), docs.indexOf(activeDoc()));
    if (d) activate(d);
  }, { noRecord: true });

  // Help
  def('help.palette', P.help, 'Command Palette…', () => showPalette(), { shortcut: 'Ctrl+Shift+P', noRecord: true });
  def('help.keys', P.help, 'Keyboard Shortcuts', () => {
    const rows = order
      .map((id) => commands.get(id) )
      .filter((c) => c.shortcut && !c.hidden)
      .map((c) => [c.shortcut , `${c.path} › ${c.label}`]);
    showPanel('Keyboard shortcuts', el('div', { class: 'ap-panel-pad' }, grid(['Shortcut', 'Command'], rows)));
  }, { noRecord: true });
  def('help.about', P.help, 'About ArchPad', () =>
    messageDialog(root, 'About ArchPad', [
      el('p', {}, el('strong', { text: 'ArchPad' }), ' — a Notepad++-style editor for configs, scripts and logs, part of ArchToolKit.'),
      el('p', { text: `Running ${host.kind === 'exe' ? 'as ArchPad.exe' : 'in the browser'}. Everything stays on this machine: no network access.` }),
      el('p', { text: 'Editor: CodeMirror 6 (MIT). Ctrl+Shift+P opens the command palette with every command and tool.' }),
    ]), { noRecord: true });

  function cycleTab(dir        )       {
    if (docs.length < 2) return;
    const i = docs.indexOf(activeDoc());
    const next = docs[(i + dir + docs.length) % docs.length] ;
    activate(next);
  }

  // ---- Command execution and key bindings -------------------------------------------

  async function exec(id        , fromMacro = false)                {
    const c = commands.get(id);
    if (!c) return;
    if (c.enabled && !c.enabled()) return;
    if (recorder.recording && !c.noRecord && !fromMacro) recorder.add({ t: 'cmd', id });
    try {
      await c.run();
    } catch (err) {
      notify(`${c.label}: ${errorText(err)}`, 'error');
    }
    scheduleStatus();
  }

  const bindings = new Map                ();
  for (const id of order) {
    const c = commands.get(id) ;
    if (c.showOnly) continue;
    const keys = [...(c.shortcut ? [normalizeShortcut(c.shortcut)] : []), ...(c.keys ?? [])];
    for (const k of keys) if (!bindings.has(k)) bindings.set(k, id);
  }

  const inScope = (target                    )          => {
    const t = target               ;
    return !t || t === document.body || t === document.documentElement || root.contains(t);
  };
  const isField = (t             )          =>
    !t.closest('.cm-editor') && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest('dialog'));

  function onKeyDown(e               )       {
    if (menuBar.isOpen) {
      if (menuBar.handleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (!inScope(e.target) || e.defaultPrevented) return;
    const target = e.target               ;
    if (target && target !== document.body && isField(target)) return;
    if (e.getModifierState?.('AltGraph')) return;
    const sc = eventToShortcut(e);
    if (!sc) return;
    const id = bindings.get(sc);
    if (id) {
      e.preventDefault();
      e.stopPropagation();
      void exec(id);
      return;
    }
    if (/^Alt\+[A-Z]$/.test(sc) && menuBar.openByMnemonic(sc.slice(4))) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (recorder.recording && target?.closest?.('.cm-content') && editingKeys().has(sc)) recorder.add({ t: 'key', k: sc });
  }
  document.addEventListener('keydown', onKeyDown, true);

  // ---- Menus -----------------------------------------------------------------------

  const SEP = 'separator'         ;
  function item(id        )           {
    const c = commands.get(id);
    if (!c) return SEP;
    return {
      label: c.dynamicLabel ? c.dynamicLabel() : c.label,
      shortcut: c.shortcut,
      run: () => void exec(id),
      checked: c.checked?.(),
      radio: c.radio,
      disabled: c.enabled ? !c.enabled() : false,
    };
  }
  const items = (...ids          )             => ids.map((id) => (id === '-' ? SEP : item(id)));
  const submenu = (label        , build                  )           => ({ label, submenu: build });

  /** The host's tool commands for one top menu: ungrouped first, then a submenu per group. */
  function toolItems(menu                 )             {
    const mine = toolCommands.filter((t) => t.menu === menu && commands.has(t.id));
    if (!mine.length) return [];
    const flat = mine.filter((t) => !t.group).map((t) => item(t.id));
    const groups           = [];
    for (const t of mine) if (t.group && !groups.includes(t.group)) groups.push(t.group);
    return [...flat, ...groups.map((g) => submenu(g, () => mine.filter((t) => t.group === g).map((t) => item(t.id))))];
  }
  const withTools = (menu                 , base            )             => {
    const extra = toolItems(menu);
    return extra.length ? [...base, SEP, ...extra] : base;
  };

  function recentItems()             {
    if (!recent.length) return [{ label: '(no recent files)', disabled: true }];
    return [...recent.map((r, i)           => ({ label: `${i + 1}: ${r.path ?? r.name}`, run: () => void openRecent(r) })), SEP, ...items('file.openAllRecent', 'file.clearRecent')];
  }

  function languageItems()             {
    const config = ['cisco', 'junos', 'ini', 'hcl', 'log', 'nginx', 'properties', 'toml', 'yaml', 'json', 'xml', 'powershell', 'shell'];
    const letters = new Map                  ();
    for (const l of LANGUAGES) {
      if (l.id === 'text') continue;
      const letter = l.label[0] .toUpperCase();
      const list = letters.get(letter) ?? [];
      list.push(l.id);
      letters.set(letter, list);
    }
    return [
      ...items('lang.auto', '-', 'lang.text'),
      submenu('Network & config', () => items(...config.map((id) => `lang.${id}`))),
      SEP,
      ...[...letters.keys()].sort().map((letter) => submenu(letter, () => items(...letters.get(letter) .map((id) => `lang.${id}`)))),
    ];
  }

  const menus            = [
    {
      label: 'File',
      mnemonic: 'F',
      items: () =>
        withTools('File', [
          ...items('file.new', 'file.open', 'file.reload', '-', 'file.save', 'file.saveAs', 'file.saveCopy', 'file.saveAll', 'file.rename', '-', 'file.close', 'file.closeAll'),
          submenu('Close Multiple Documents', () => items('file.closeOthers', 'file.closeLeft', 'file.closeRight', 'file.closeUnchanged')),
          SEP,
          ...items('file.restoreClosed'),
          submenu('Recent Files', recentItems),
        ]),
    },
    {
      label: 'Edit',
      mnemonic: 'E',
      items: () =>
        withTools('Edit', [
          ...items('edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll', '-'),
          submenu('Copy to Clipboard', () => items('edit.copyPath', 'edit.copyName', 'edit.copyDir')),
          submenu('Indent', () => items('edit.indent', 'edit.outdent')),
          submenu('Convert Case to', () => items(...CASES.map(([m]) => `edit.case.${m}`))),
          submenu('Line Operations', () =>
            items(
              'edit.duplicate',
              'edit.deleteLine',
              'edit.moveUp',
              'edit.moveDown',
              'edit.transpose',
              '-',
              'edit.removeDup',
              'edit.removeConsecDup',
              'edit.split',
              'edit.join',
              '-',
              'edit.blankAbove',
              'edit.blankBelow',
              '-',
              'edit.reverse',
              ...SORTS.map(([m]) => `edit.sort.${m}`),
              '-',
              'edit.removeEmpty',
              'edit.removeBlank',
              'edit.squeeze',
            ),
          ),
          submenu('Comment/Uncomment', () => items('edit.toggleComment', 'edit.comment', 'edit.uncomment', 'edit.blockComment')),
          submenu('Blank Operations', () =>
            items('edit.trimTrailing', 'edit.trimLeading', 'edit.trimBoth', 'edit.eolToSpace', 'edit.trimEolToSpace', '-', 'edit.tabToSpace', 'edit.spaceToTabAll', 'edit.spaceToTabLeading'),
          ),
          submenu('EOL Conversion', () => items(...EOLS.map((e) => `edit.eol.${e}`))),
          SEP,
          submenu('Multi-select', () => items('edit.multiNext', 'edit.multiAll', 'edit.cursorAbove', 'edit.cursorBelow')),
          ...items('edit.columnMode', 'edit.columnEditor', '-', 'edit.readOnly'),
        ]),
    },
    {
      label: 'Search',
      mnemonic: 'S',
      items: () =>
        withTools('Search', [
          ...items(
            'search.find',
            'search.findInFiles',
            'search.next',
            'search.prev',
            'search.selNext',
            'search.selPrev',
            '-',
            'search.replace',
            '-',
            'search.results',
            'search.nextResult',
            'search.prevResult',
            '-',
            'search.goto',
            'search.brace',
            'search.selectBrace',
            '-',
            'search.mark',
            'search.clearMarks',
          ),
          submenu('Bookmark', () => items('bm.toggle', 'bm.next', 'bm.prev', 'bm.clear', '-', 'bm.cut', 'bm.copy', 'bm.remove', 'bm.removeUnmarked', 'bm.inverse')),
        ]),
    },
    {
      label: 'View',
      mnemonic: 'V',
      items: () =>
        withTools('View', [
          ...items('view.fullscreen', '-', 'view.wrap'),
          submenu('Show Symbol', () => items('view.whitespace', 'view.eol', 'view.allChars', '-', 'view.guides')),
          ...items('view.lineNumbers'),
          submenu('Zoom', () => items('view.zoomIn', 'view.zoomOut', 'view.zoomReset')),
          submenu('Theme', () => items(...THEMES.map(([t]) => `view.theme.${t}`))),
          SEP,
          ...items('view.foldAll', 'view.unfoldAll', 'view.foldCurrent', 'view.unfoldCurrent', '-', 'view.moveOther', 'view.switchView', 'view.closeOther', '-', 'view.tabSettings', 'view.summary'),
        ]),
    },
    {
      label: 'Encoding',
      mnemonic: 'N',
      items: () => withTools('Encoding', items(...ALL_ENCODINGS.map((e) => `enc.in.${e}`), '-', ...ALL_ENCODINGS.map((e) => `enc.to.${e}`))),
    },
    { label: 'Language', mnemonic: 'L', items: () => withTools('Language', languageItems()) },
    {
      label: 'Tools',
      mnemonic: 'T',
      items: () => [submenu('Compare', () => items('compare.open', 'compare.next', 'compare.prev', 'compare.close')), SEP, ...toolItems('Tools'), SEP, ...items('help.palette')],
    },
    {
      label: 'Network',
      mnemonic: 'K',
      items: () => {
        const list = toolItems('Network');
        return list.length ? list : [{ label: '(no network tools loaded)', disabled: true }];
      },
    },
    {
      label: 'Macro',
      mnemonic: 'M',
      items: () =>
        withTools('Macro', [
          ...items('macro.record', 'macro.play', 'macro.save', 'macro.runMulti'),
          ...(savedMacros.length ? [SEP, ...savedMacros.map((m)           => ({ label: m.name, run: () => void playMacro(m.steps, 1) }))] : []),
          SEP,
          ...items('macro.show', 'macro.delete'),
        ]),
    },
    {
      label: 'Window',
      mnemonic: 'W',
      items: () =>
        withTools('Window', [
          ...items('win.next', 'win.prev', 'win.sort', 'win.list'),
          SEP,
          ...docs.slice(0, 30).map((d, i)           => ({ label: `${i + 1}: ${d.dirty ? '*' : ''}${d.name}`, run: () => activate(d), checked: d === activeDoc(), radio: true, title: d.path ?? d.name })),
        ]),
    },
    { label: 'Help', mnemonic: 'H', items: () => withTools('Help', items('help.palette', 'help.keys', '-', 'help.about')) },
  ];

  const menuBar = createMenuBar(root, menus);
  topBar.appendChild(menuBar.element);

  function tabContextMenu(d     )             {
    const run = (fn               ) => () => {
      activate(d, false);
      void fn();
    };
    return [
      { label: 'Close', shortcut: 'Ctrl+W', run: () => void closeDoc(d) },
      { label: 'Close All but This', run: () => void closeMany(docs.filter((x) => x !== d)) },
      { label: 'Close All to the Left', run: () => void closeMany(docs.slice(0, docs.indexOf(d))) },
      { label: 'Close All to the Right', run: () => void closeMany(docs.slice(docs.indexOf(d) + 1)) },
      { label: 'Close All', run: () => void closeMany([...docs]) },
      SEP,
      { label: 'Save', run: run(() => saveDoc(d)) },
      { label: 'Save As…', run: run(() => saveDoc(d, 'as')) },
      { label: 'Rename…', run: run(() => exec('file.rename')) },
      { label: 'Reload from Disk', run: run(() => reloadDoc(d)), disabled: d.untitled },
      SEP,
      { label: 'Copy Full File Path', run: () => void writeClipboard(d.path ?? d.name, 'Path') },
      { label: 'Copy Filename', run: () => void writeClipboard(d.name, 'File name') },
      SEP,
      { label: 'Move to Other View', run: run(() => moveToOtherView()) },
      { label: 'Compare with…', run: run(() => compareOpen()) },
      { label: 'Read-Only', checked: d.readOnly, run: () => setReadOnly(d, !d.readOnly) },
    ];
  }

  function editorContextMenu()             {
    return [
      ...items('edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', '-', 'edit.selectAll', '-'),
      submenu('Convert Case to', () => items(...CASES.map(([m]) => `edit.case.${m}`))),
      ...items('edit.toggleComment', 'edit.blockComment', '-', 'bm.toggle', 'search.find', 'search.mark', '-', 'help.palette'),
    ];
  }

  function statusMenu(kind                        , anchor             )       {
    const r = anchor.getBoundingClientRect();
    const list = kind === 'eol' ? items(...EOLS.map((e) => `edit.eol.${e}`)) : kind === 'enc' ? menus[4] .items() : languageItems();
    menuBar.context(list, r.left, Math.max(4, r.top - Math.min(420, list.length * 26 + 12)));
  }
  sEol.addEventListener('click', () => statusMenu('eol', sEol));
  sEnc.addEventListener('click', () => statusMenu('enc', sEnc));
  sLang.addEventListener('click', () => statusMenu('lang', sLang));
  sIns.addEventListener('click', () => void exec('edit.overwrite'));
  sPos.addEventListener('dblclick', () => void exec('search.goto'));

  function showPalette()       {
    const list                = order
      .map((id) => commands.get(id) )
      .filter((c) => !c.hidden && (!c.enabled || c.enabled()))
      .map((c) => ({ label: c.dynamicLabel ? c.dynamicLabel() : c.label, detail: c.path, shortcut: c.shortcut, run: () => void exec(c.id) }));
    for (const m of savedMacros) list.push({ label: `Run macro: ${m.name}`, detail: P.macro, run: () => void playMacro(m.steps, 1) });
    for (const d of docs) list.push({ label: `Go to tab: ${d.name}`, detail: d.path ?? P.win, run: () => activate(d) });
    openPalette(root, list, () => activeView().focus());
  }

  // ---- Full screen, drop, wheel, lifecycle ------------------------------------------

  function toggleFullscreen()       {
    const on = !root.classList.contains('is-fullscreen');
    root.classList.toggle('is-fullscreen', on);
    try {
      if (on && !document.fullscreenElement && root.requestFullscreen) void root.requestFullscreen().catch(() => undefined);
      else if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    } catch {
      // The CSS class alone still gives a full-window editor.
    }
    activeView().requestMeasure();
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && root.classList.contains('is-fullscreen')) root.classList.remove('is-fullscreen');
  });

  const carriesFiles = (e           )          => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  root.addEventListener(
    'dragover',
    (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      root.classList.add('is-dropping');
    },
    true,
  );
  root.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || !root.contains(e.relatedTarget        )) root.classList.remove('is-dropping');
  });
  root.addEventListener(
    'drop',
    (e) => {
      root.classList.remove('is-dropping');
      if (!carriesFiles(e) || !e.dataTransfer?.files.length) return;
      // Capture phase: CodeMirror would otherwise paste the file's text into the document.
      e.preventDefault();
      e.stopPropagation();
      const files = [...e.dataTransfer.files];
      // Chromium can hand over a handle, so a dropped file saves back in place.
      const handles = [...e.dataTransfer.items]
        .filter((i) => i.kind === 'file')
        .map((i) => {
          const get = (i                                                                         ).getAsFileSystemHandle;
          try {
            return get ? get.call(i).catch(() => null) : Promise.resolve(null);
          } catch {
            return Promise.resolve(null);
          }
        });
      void (async () => {
        const opened               = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i] ;
          const handle = (await handles[i])                            ;
          try {
            opened.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), lastModified: f.lastModified, handle: handle?.kind === 'file' ? handle : undefined });
          } catch (err) {
            notify(`Could not read ${f.name}: ${errorText(err)}`, 'error');
          }
        }
        if (opened.length) await openFiles(opened);
      })();
    },
    true,
  );

  main.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  const flush = ()       => void persistSession(true);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  host.onBeforeClose(() => {
    flush();
    const dirty = docs.filter((d) => d.dirty);
    if (!dirty.length) return true;
    if (host.kind === 'browser') return false;
    return (async () => {
      const choice = await openDialog                            ({
        host: root,
        title: 'Close ArchPad',
        body: [
          el('p', { text: `${plural(dirty.length, 'document')} ${dirty.length === 1 ? 'has' : 'have'} unsaved changes:` }),
          el('ul', { class: 'ap-list' }, ...dirty.slice(0, 12).map((d) => el('li', { text: d.path ?? d.name }))),
          el('p', { class: 'ap-hint', text: 'Unsaved text is kept in the session and comes back next time, even if you do not save.' }),
        ],
        buttons: [
          { label: 'Save All', value: 'save', primary: true },
          { label: 'Close (keep in session)', value: 'keep' },
          { label: 'Cancel', value: 'cancel' },
        ],
        cancelValue: 'cancel',
      });
      if (choice === 'cancel') return false;
      if (choice === 'save') {
        for (const d of dirty) {
          if (!docs.includes(d)) continue;
          activate(d, false);
          if (!(await saveDoc(d))) return false;
        }
      }
      await persistSession(true);
      return true;
    })();
  });

  // ---- Start -----------------------------------------------------------------------

  const first = newUntitled();
  makePane(first);
  applySettings(false);
  refreshUi();
  activeView().focus();
  void restoreSession();

  const api             = {
    open(files) {
      void openFiles(files);
    },
    newDocument(name, text, language) {
      const resolved = resolveLanguage(language);
      const lang = resolved ?? detectLanguage(name, text);
      const doc = createDoc({ name, text, untitled: true, language: lang, languageLocked: !!resolved, savedText: '' });
      const pristine = activeDoc();
      insertDoc(doc);
      activate(doc);
      if (isPristine(pristine) && docs.length > 1 && pristine !== doc) removeDoc(pristine, false);
      scheduleSession();
    },
    hasUnsaved() {
      return docs.some((d) => d.dirty);
    },
  };

  // Keep the find dialog from outliving a remount (tests, hot reload).
  closeFindDialog();
  return api;
}

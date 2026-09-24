/**
 * CodeMirror extensions ArchPad adds on top of the stock ones: bookmarks
 * (with a gutter and a line tint), search marks, the document's line ending
 * as editor state (so "Show EOL" can draw it), indent guides, overwrite
 * mode, and the theme and highlight style built on the toolkit's tokens.
 */

import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  StateField,
  StateEffect,
  gutter,
  GutterMarker,
  HighlightStyle,
  syntaxHighlighting,
  RangeSetBuilder,
  tags as t,
} from '../vendor/archpad-editor.js';
                                      

// The vendor bundle has no type declarations; these are the shapes this file relies on.
/* eslint-disable @typescript-eslint/no-explicit-any */
                 
                
                   

// ---- Bookmarks ----------------------------------------------------------

/** Toggle the bookmark on the line containing the position. */
export const toggleBookmark = StateEffect.define({ map: (pos        , mapping     ) => mapping.mapPos(pos) });
/** Replace every bookmark with bookmarks on these line-start positions. */
export const setBookmarks = StateEffect.define();

const bookmarkLine = Decoration.line({ class: 'ap-bookmarked' });

function bookmarkSet(state       , starts                  )          {
  const unique = [...new Set([...starts].map((p) => state.doc.lineAt(Math.min(p, state.doc.length)).from))].sort((a, b) => a - b);
  return Decoration.set(unique.map((p) => bookmarkLine.range(p)));
}

function positions(set         )           {
  const out           = [];
  const iter = set.iter();
  while (iter.value) {
    out.push(iter.from);
    iter.next();
  }
  return out;
}

export const bookmarkField = StateField.define({
  create: () => Decoration.none,
  update(set         , tr     ) {
    let next = set;
    if (tr.docChanged) {
      // Snap back to line starts: joining two lines can map a bookmark into the middle of one.
      next = bookmarkSet(tr.state, positions(set.map(tr.changes)));
    }
    for (const e of tr.effects) {
      if (e.is(toggleBookmark)) {
        const line = tr.state.doc.lineAt(e.value);
        const current = positions(next);
        next = current.includes(line.from) ? bookmarkSet(tr.state, current.filter((p) => p !== line.from)) : bookmarkSet(tr.state, [...current, line.from]);
      } else if (e.is(setBookmarks)) {
        next = bookmarkSet(tr.state, e.value            );
      }
    }
    return next;
  },
  provide: (f     ) => EditorView.decorations.from(f),
});

/** 1-based line numbers of the bookmarked lines, in order. */
export function bookmarkedLines(state       )           {
  return positions(state.field(bookmarkField, false) ?? Decoration.none).map((p) => state.doc.lineAt(p).number);
}

class BookmarkMarker extends GutterMarker {
  toDOM()              {
    const dot = document.createElement('span');
    dot.className = 'ap-bm-dot';
    dot.title = 'Bookmark (Ctrl+F2)';
    return dot;
  }
}
const bookmarkMarker = new BookmarkMarker();

/** The bookmark margin: click it to toggle, as in Notepad++. */
export const bookmarkGutter = gutter({
  class: 'ap-bm-gutter',
  lineMarker(view      , line     ) {
    let has = false;
    view.state.field(bookmarkField).between(line.from, line.from, (from        ) => {
      if (from === line.from) has = true;
    });
    return has ? bookmarkMarker : null;
  },
  lineMarkerChange: (u     ) => u.startState.field(bookmarkField) !== u.state.field(bookmarkField),
  initialSpacer: () => bookmarkMarker,
  domEventHandlers: {
    mousedown(view      , line     ) {
      view.dispatch({ effects: toggleBookmark.of(line.from) });
      return true;
    },
  },
});

// ---- Search marks ("Mark All") -----------------------------------------

export const setMarks = StateEffect.define();
const markDeco = Decoration.mark({ class: 'ap-mark' });

export const markField = StateField.define({
  create: () => Decoration.none,
  update(set         , tr     ) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMarks)) {
        const ranges = (e.value                                  ).filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
        next = Decoration.set(ranges.map((r) => markDeco.range(r.from, r.to)));
      }
    }
    return next;
  },
  provide: (f     ) => EditorView.decorations.from(f),
});

export function markCount(state       )         {
  return positions(state.field(markField, false) ?? Decoration.none).length;
}

/** The marked ranges, in order (so "Mark All" without purge can add to them). */
export function markRanges(state       )                                 {
  const out                                 = [];
  const iter = (state.field(markField, false) ?? Decoration.none).iter();
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

// ---- The document's line ending ----------------------------------------

export const setEol = StateEffect.define();

/** CodeMirror keeps "\n" internally; the file's real ending lives here for the status bar and "Show EOL". */
export const eolField = StateField.define({
  create: ()      => 'CRLF',
  update(value     , tr     ) {
    for (const e of tr.effects) if (e.is(setEol)) return e.value       ;
    return value;
  },
});

class EolWidget extends WidgetType {
           label        ;
  constructor(label        ) {
    super();
    this.label = label;
  }
  eq(other           )          {
    return other.label === this.label;
  }
  toDOM()              {
    const span = document.createElement('span');
    span.className = 'ap-eol';
    span.textContent = this.label;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent()          {
    return false;
  }
}

/** "Show End of Line": a CR LF / LF / CR pill at the end of every visible line but the last. */
export const eolMarkers = ViewPlugin.fromClass(
  class {
    decorations         ;
    constructor(view      ) {
      this.decorations = this.build(view);
    }
    update(u     )       {
      if (u.docChanged || u.viewportChanged || u.startState.field(eolField) !== u.state.field(eolField)) this.decorations = this.build(u.view);
    }
    build(view      )          {
      const eol      = view.state.field(eolField);
      const label = eol === 'CRLF' ? 'CRLF' : eol;
      const widget = Decoration.widget({ widget: new EolWidget(label), side: 1 });
      const builder = new RangeSetBuilder();
      const doc = view.state.doc;
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = doc.lineAt(pos);
          if (line.number < doc.lines) builder.add(line.to, line.to, widget);
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v     ) => v.decorations },
);

// ---- Indent guides ------------------------------------------------------

const guideDeco = Decoration.mark({ class: 'ap-indent' });

/** Vertical guides through leading whitespace, one per tab stop (drawn by CSS on the marked span). */
export const indentGuides = ViewPlugin.fromClass(
  class {
    decorations         ;
    constructor(view      ) {
      this.decorations = this.build(view);
    }
    update(u     )       {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view      )          {
      const builder = new RangeSetBuilder();
      const doc = view.state.doc;
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = doc.lineAt(pos);
          const lead = /^[ \t]+/.exec(line.text);
          if (lead) builder.add(line.from, line.from + lead[0].length, guideDeco);
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v     ) => v.decorations },
);

// ---- Overwrite (OVR) ----------------------------------------------------

/** Typing replaces the character under the cursor when `active()` says so (Insert key), within the line. */
export function overwriteMode(active               )          {
  return EditorView.inputHandler.of((view      , from        , to        , text        ) => {
    if (!active() || from !== to || text.includes('\n') || view.state.selection.ranges.length > 1) return false;
    const line = view.state.doc.lineAt(from);
    const end = Math.min(line.to, from + [...text].length);
    view.dispatch({ changes: { from, to: end, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type', scrollIntoView: true });
    return true;
  });
}

// ---- Theme --------------------------------------------------------------

/**
 * Colours are CSS variables set by archpad.css, so the three themes (follow
 * the toolkit, always dark, light) are a class on the root, not a rebuild.
 */
export const archpadTheme = EditorView.theme({
  '&': { color: 'var(--ap-text)', backgroundColor: 'var(--ap-editor-bg)', height: '100%', fontSize: 'var(--ap-font-size, 14px)' },
  '.cm-scroller': { fontFamily: 'var(--ap-font, var(--mono, Consolas, monospace))', lineHeight: '1.45' },
  '.cm-content': { caretColor: 'var(--ap-caret)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ap-caret)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--ap-selection) !important',
  },
  '.cm-activeLine': { backgroundColor: 'var(--ap-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--ap-active-line)', color: 'var(--ap-text)' },
  '.cm-gutters': { backgroundColor: 'var(--ap-gutter-bg)', color: 'var(--ap-gutter-text)', borderRight: '1px solid var(--ap-border)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--ap-accent-dim)', color: 'var(--ap-text)', border: 'none', padding: '0 4px' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ap-selection-match)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--ap-bracket)', outline: '1px solid var(--ap-accent)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--ap-danger-dim)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ap-mark)' },
  '.cm-highlightSpace': { backgroundImage: 'radial-gradient(circle at 50% 55%, var(--ap-whitespace) 16%, transparent 5%)' },
  '.cm-highlightTab': {
    backgroundImage: 'none',
    position: 'relative',
  },
  '.cm-highlightTab::before': { content: '"→"', position: 'absolute', left: '0', color: 'var(--ap-whitespace)' },
  '.cm-tooltip': { backgroundColor: 'var(--ap-surface)', color: 'var(--ap-text)', border: '1px solid var(--ap-border)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--ap-accent)', color: '#fff' },
  '.cm-panels': { backgroundColor: 'var(--ap-surface)', color: 'var(--ap-text)' },
});

export const archpadHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--ap-syn-keyword)', fontWeight: '600' },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--ap-syn-comment)', fontStyle: 'italic' },
    { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], color: 'var(--ap-syn-string)' },
    { tag: [t.number, t.integer, t.float], color: 'var(--ap-syn-number)' },
    { tag: [t.bool, t.null, t.atom, t.self], color: 'var(--ap-syn-atom)' },
    { tag: [t.typeName, t.className, t.namespace, t.tagName], color: 'var(--ap-syn-type)' },
    { tag: [t.propertyName, t.attributeName], color: 'var(--ap-syn-property)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--ap-syn-function)' },
    { tag: [t.definition(t.variableName), t.variableName, t.labelName], color: 'var(--ap-syn-variable)' },
    { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: 'var(--ap-syn-heading)', fontWeight: '700' },
    { tag: [t.meta, t.processingInstruction, t.documentMeta], color: 'var(--ap-syn-meta)' },
    { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--ap-syn-operator)' },
    { tag: t.invalid, color: 'var(--ap-syn-error)', fontWeight: '700' },
    { tag: t.annotation, color: 'var(--ap-syn-warn)', fontWeight: '700' },
    { tag: [t.link, t.url], color: 'var(--ap-syn-link)', textDecoration: 'underline' },
    { tag: t.inserted, color: 'var(--ap-syn-inserted)' },
    { tag: t.deleted, color: 'var(--ap-syn-deleted)' },
    { tag: t.changed, color: 'var(--ap-syn-warn)' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: '700' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
  ]),
);

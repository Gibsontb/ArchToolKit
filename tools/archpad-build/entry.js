// The CodeMirror 6 pieces ArchPad uses, bundled once into src/vendor/archpad-editor.js
// by tools/archpad-build/build.mjs. Rebuild only to upgrade CodeMirror.

export { EditorState, EditorSelection, Compartment, StateEffect, StateField, Text, Prec, RangeSetBuilder, Transaction, Annotation, Facet } from '@codemirror/state';
export {
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
  Decoration,
  ViewPlugin,
  gutter,
  GutterMarker,
  WidgetType,
  showPanel,
  scrollPastEnd,
} from '@codemirror/view';
export {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  selectAll,
  toggleComment,
  indentMore,
  indentLess,
  cursorLineUp,
  cursorLineDown,
  copyLineDown,
  copyLineUp,
  moveLineDown,
  moveLineUp,
  deleteLine,
  selectLine,
  insertNewlineAndIndent,
  cursorMatchingBracket,
  selectMatchingBracket,
  toggleBlockComment,
  toggleLineComment,
  lineComment,
  lineUncomment,
  addCursorAbove,
  addCursorBelow,
} from '@codemirror/commands';
export {
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
  StreamLanguage,
  LanguageSupport,
  bracketMatching,
  foldGutter,
  foldKeymap,
  foldAll,
  unfoldAll,
  indentOnInput,
  indentUnit,
  syntaxTree,
  foldCode,
  unfoldCode,
  foldService,
  StringStream,
} from '@codemirror/language';
export {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  closeSearchPanel,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  selectMatches,
  selectNextOccurrence,
  selectSelectionMatches,
  gotoLine,
} from '@codemirror/search';
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { lintGutter, linter, lintKeymap, setDiagnostics } from '@codemirror/lint';
export { MergeView, unifiedMergeView, getChunks, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
export { tags } from '@lezer/highlight';

// Languages with full parsers.
export { javascript } from '@codemirror/lang-javascript';
export { json, jsonParseLinter } from '@codemirror/lang-json';
export { xml } from '@codemirror/lang-xml';
export { yaml } from '@codemirror/lang-yaml';
export { python } from '@codemirror/lang-python';
export { sql } from '@codemirror/lang-sql';
export { markdown } from '@codemirror/lang-markdown';
export { html } from '@codemirror/lang-html';
export { css } from '@codemirror/lang-css';
export { cpp } from '@codemirror/lang-cpp';
export { java } from '@codemirror/lang-java';
export { go } from '@codemirror/lang-go';
export { rust } from '@codemirror/lang-rust';
export { php } from '@codemirror/lang-php';

// Stream (legacy) modes for the rest: shells, config formats, and more.
export { shell } from '@codemirror/legacy-modes/mode/shell';
export { powerShell } from '@codemirror/legacy-modes/mode/powershell';
export { properties } from '@codemirror/legacy-modes/mode/properties';
export { toml } from '@codemirror/legacy-modes/mode/toml';
export { nginx } from '@codemirror/legacy-modes/mode/nginx';
export { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
export { diff } from '@codemirror/legacy-modes/mode/diff';
export { ruby } from '@codemirror/legacy-modes/mode/ruby';
export { perl } from '@codemirror/legacy-modes/mode/perl';
export { lua } from '@codemirror/legacy-modes/mode/lua';
export { csharp, kotlin, scala } from '@codemirror/legacy-modes/mode/clike';
export { vb } from '@codemirror/legacy-modes/mode/vb';
export { vbScript } from '@codemirror/legacy-modes/mode/vbscript';
export { r } from '@codemirror/legacy-modes/mode/r';
export { protobuf } from '@codemirror/legacy-modes/mode/protobuf';
export { http } from '@codemirror/legacy-modes/mode/http';
export { cmake } from '@codemirror/legacy-modes/mode/cmake';
export { puppet } from '@codemirror/legacy-modes/mode/puppet';
export { groovy } from '@codemirror/legacy-modes/mode/groovy';
export { swift } from '@codemirror/legacy-modes/mode/swift';
export { erlang } from '@codemirror/legacy-modes/mode/erlang';
export { tcl } from '@codemirror/legacy-modes/mode/tcl';
export { fortran } from '@codemirror/legacy-modes/mode/fortran';
export { cobol } from '@codemirror/legacy-modes/mode/cobol';
export { pascal } from '@codemirror/legacy-modes/mode/pascal';
export { verilog } from '@codemirror/legacy-modes/mode/verilog';
export { vhdl } from '@codemirror/legacy-modes/mode/vhdl';
export { asn1 } from '@codemirror/legacy-modes/mode/asn1';

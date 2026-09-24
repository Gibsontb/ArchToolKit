/**
 * ArchPad's shared contract.
 *
 * ArchPad is one editor with two homes: a page in ArchToolKit (the browser)
 * and ArchPad.exe (a WebView2 window on Windows). Everything that differs
 * between them — opening and saving files, the window title, closing — goes
 * through a Host. The editor core, the tools and the page are written once
 * against these types.
 */

export type Eol = 'CRLF' | 'LF' | 'CR';
export type Encoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** A file as it comes off disk: the raw bytes are decoded by the core, not the host. */
export interface OpenedFile {
  readonly name: string;
  /** Full path on disk when the host knows it (the exe always does; the browser does not). */
  readonly path?: string;
  readonly bytes: Uint8Array;
  /** Opaque token the host uses to save back to the same file (a FileSystemFileHandle in the browser). */
  readonly handle?: unknown;
  readonly lastModified?: number;
}

export interface SaveRequest {
  readonly name: string;
  readonly path?: string;
  readonly handle?: unknown;
  readonly bytes: Uint8Array;
}

export interface SaveResult {
  readonly name: string;
  readonly path?: string;
  readonly handle?: unknown;
}

/**
 * Where ArchPad runs. Browser: File System Access API with download/upload
 * fallbacks. Exe: messages to the C# host over window.chrome.webview.
 */
export interface Host {
  readonly kind: 'browser' | 'exe';
  /** Show an open dialog; resolves with the chosen files (empty when cancelled). */
  openFiles(): Promise<OpenedFile[]>;
  /** Write to the file the document came from; when it has none, behaves like saveAs. Null when cancelled. */
  save(request: SaveRequest): Promise<SaveResult | null>;
  /** Show a save dialog. Null when cancelled. */
  saveAs(request: SaveRequest): Promise<SaveResult | null>;
  /** Pick a folder and list its files (for Find in Files). Null when cancelled or unsupported. */
  openFolder(): Promise<{ readonly name: string; readonly files: readonly OpenedFile[] } | null>;
  /** Read a file by path again (reload from disk). Exe only; the browser re-reads through its handle. */
  reload?(file: { readonly path?: string; readonly handle?: unknown }): Promise<OpenedFile | null>;
  /** The window title, e.g. "*config.txt - ArchPad". */
  setTitle(title: string): void;
  /** Called by the host before the window closes; return false to keep it open (unsaved changes). */
  onBeforeClose(handler: () => boolean | Promise<boolean>): void;
  /** Files handed to ArchPad from outside: the exe's command line / Explorer drop, or the toolkit's "Open in ArchPad". */
  onOpenRequest(handler: (files: OpenedFile[]) => void): void;
}

/** A menu item. Tools, line operations and plugins all register as commands. */
export interface Command {
  readonly id: string;
  readonly label: string;
  /** Top-level menu it lives in. */
  readonly menu: 'File' | 'Edit' | 'Search' | 'View' | 'Encoding' | 'Language' | 'Tools' | 'Network' | 'Macro' | 'Window' | 'Help';
  /** Submenu inside that menu, e.g. "Line Operations", "Convert Case to", "JSON". */
  readonly group?: string;
  /** Notepad++-style shortcut, e.g. "Ctrl+Shift+D". Shown in the menu and bound. */
  readonly shortcut?: string;
  readonly run: (ctx: CommandContext) => void | Promise<void>;
}

/** What a command can see and change: the active document's text and selection, and a way to report. */
export interface CommandContext {
  /** The whole text of the active document. */
  getText(): string;
  /** The selected text, or '' when nothing is selected. */
  getSelection(): string;
  /** Replace the selection (or the whole document when nothing is selected, if `wholeWhenEmpty`). */
  replaceSelection(text: string, options?: { readonly wholeWhenEmpty?: boolean }): void;
  /** Replace the whole document. */
  setText(text: string): void;
  /** Open a new tab with this content. */
  newDocument(name: string, text: string, language?: string): void;
  /** A short message in the status bar (errors in red). */
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Ask for a line of input (a simple prompt dialog). Null when cancelled. */
  prompt(label: string, initial?: string): Promise<string | null>;
  /** Show a result panel (Find results, regex matches, hashes). */
  showPanel(title: string, body: HTMLElement | string): void;
}

/** What the page or the exe gets back from mounting ArchPad (src/archpad/app.ts exports `mountArchPad`). */
export interface ArchPadApi {
  /** Open files in new tabs (or focus the tab that already has them). */
  open(files: readonly OpenedFile[]): void;
  /** A new tab with this text. */
  newDocument(name: string, text: string, language?: string): void;
  /** True when any tab has unsaved changes. */
  hasUnsaved(): boolean;
}

export interface MountOptions {
  /** Extra commands (the tools) added to the menus. */
  readonly commands?: readonly Command[];
  /** 'page' inside the toolkit (below its header) or 'app' filling the whole window (the exe). */
  readonly layout?: 'page' | 'app';
}

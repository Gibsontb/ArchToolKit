/**
 * The Host for ArchPad.exe: every file operation is a message to the C# side
 * over WebView2's window.chrome.webview bridge.
 *
 * The page cannot touch the disk from inside WebView2, and the browser's File
 * System Access API would hand back handles without paths, which is useless
 * for an editor whose title bar, "Reload from disk" and recent-files list all
 * want the real path. So the exe owns the dialogs and the disk, and this file
 * is the page's half of a small request/response protocol.
 *
 * Wire protocol (both directions are plain JSON objects with a `kind`):
 *
 *   page -> exe
 *     { kind: 'hello' }                         bridge is up; the exe may now ask before closing
 *     { kind: 'ready' }                         an open-request handler exists; flush queued files
 *     { kind: 'request', id, op, ... }          op: openFiles | save | saveAs | openFolder | reload
 *     { kind: 'setTitle', title }
 *     { kind: 'closeAnswer', id, close }        answer to a beforeClose question
 *     { kind: 'drop' } + additional objects     files dropped from Explorer (paths travel as File objects)
 *
 *   exe -> page
 *     { kind: 'response', id, ok: true, result } | { kind: 'response', id, ok: false, error }
 *     { kind: 'partial', id, files }            a batch of files ahead of the response (openFolder)
 *     { kind: 'beforeClose', id }               the window wants to close
 *     { kind: 'openRequest', files }            command line, Explorer drop, second instance
 *
 * Files travel as { name, path, data, lastModified } with data in base64:
 * WebView2 messages are strings, and base64 is the one byte encoding both
 * sides decode natively. The C# counterpart is desktop/ArchPad/Bridge.cs.
 */

                                                                            

/** A file as it crosses the bridge. */
                           
                        
                         
                                 
                        
                                 
 

/** The part of window.chrome.webview this host uses; a fake stands in for it in tests. */
                                
                                      
                                                                                           
                                                                                         
                                                                                        
 

                                 
                                           
                                  
                                                                                          
                                           
 

/** True when the page is running inside the ArchPad.exe WebView2 window. */
export function isExeHost()          {
  return findBridge() !== undefined;
}

function findBridge()                            {
  const chrome = (globalThis                                            ).chrome;
  return chrome?.webview;
}

// ---------------------------------------------------------------------------
// Base64. Large files are the normal case for an editor (logs, dumps), so
// both directions work in slices: String.fromCharCode(...bytes) on a whole
// 50 MB file would blow the argument limit, and atob on it is fine but the
// per-character copy into a Uint8Array is the cost either way.
// ---------------------------------------------------------------------------

const SLICE = 0x8000;

export function bytesToBase64(bytes            )         {
  const native = (bytes                                            ).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += SLICE) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + SLICE)));
  }
  return btoa(binary);
}

export function base64ToBytes(data        )             {
  const native = (Uint8Array                                                         ).fromBase64;
  if (typeof native === 'function') return native(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function fromWire(file          )             {
  const opened                                                       = {
    name: file.name,
    bytes: base64ToBytes(file.data ?? ''),
  };
  if (file.path) opened.path = file.path;
  if (typeof file.lastModified === 'number') opened.lastModified = file.lastModified;
  return opened;
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

/** A response plus the files that came ahead of it in 'partial' batches. */
                    
                     
                               
 

                   
                                       
                             
                                                                      
                      
 

               
                                                                                   
                                                      
                                       
                                               

export function createExeHost(options                 = {})       {
  const bridge = options.bridge ?? findBridge();
  if (!bridge) throw new Error('ArchPad: window.chrome.webview is missing; this host only runs inside ArchPad.exe.');

  let nextId = 1;
  const pending = new Map                 ();
  let closeHandler                                            = null;
  let openHandler                                         = null;
  // Files the exe sends before the page has registered its handler (the
  // command line is delivered as soon as the page loads) wait here.
  const queuedOpens                 = [];

  function request   (op        , args                          = {})                    {
    const id = nextId++;
    return new Promise          ((resolve, reject) => {
      pending.set(id, { resolve: resolve                               , reject, files: [] });
      bridge .postMessage({ kind: 'request', id, op, ...args });
    });
  }

  function take(id        )                      {
    const entry = pending.get(id);
    pending.delete(id);
    return entry;
  }

  async function answerClose(id        )                {
    let close = true;
    if (closeHandler) {
      try {
        close = (await closeHandler()) !== false;
      } catch (error) {
        // A broken handler must not lose unsaved work; the exe still lets the
        // user force the window shut with a second close after a delay.
        console.error('ArchPad: before-close handler failed', error);
        close = false;
      }
    }
    bridge .postMessage({ kind: 'closeAnswer', id, close });
  }

  function deliver(files              )       {
    if (files.length === 0) return;
    if (openHandler) openHandler(files);
    else queuedOpens.push(files);
  }

  bridge.addEventListener('message', (event) => {
    const message = event.data                   ;
    if (!message || typeof message !== 'object') return;
    switch (message.kind) {
      case 'response': {
        const entry = take(message.id);
        if (!entry) return;
        if (message.ok) entry.resolve({ result: message.result ?? null, files: entry.files });
        else entry.reject(new Error(message.error || 'ArchPad.exe could not complete the request.'));
        return;
      }
      case 'partial': {
        pending.get(message.id)?.files.push(...(message.files ?? []).map(fromWire));
        return;
      }
      case 'beforeClose':
        void answerClose(message.id);
        return;
      case 'openRequest':
        deliver((message.files ?? []).map(fromWire));
        return;
    }
  });

  if (options.dropTarget !== null) {
    const target = options.dropTarget ?? (typeof window !== 'undefined' ? window : null);
    if (target && typeof bridge.postMessageWithAdditionalObjects === 'function') installDrop(target, bridge);
  }

  bridge.postMessage({ kind: 'hello' });

  function toSaveArgs(req             )                          {
    return { name: req.name, path: req.path ?? null, data: bytesToBase64(req.bytes) };
  }

  function toSaveResult(result         )                    {
    if (!result || typeof result !== 'object') return null;
    const r = result                                   ;
    return r.path ? { name: r.name, path: r.path } : { name: r.name };
  }

  return {
    kind: 'exe',

    // Large results (many files, big files) come as 'partial' batches ahead
    // of the response, because one WebView2 message has to fit in one
    // string; small ones may be inline in the response. Both are accepted.
    async openFiles() {
      const { result, files } = await request                               ('openFiles');
      return [...(result?.files ?? []).map(fromWire), ...files];
    },

    async save(req) {
      return toSaveResult((await request('save', toSaveArgs(req))).result);
    },

    async saveAs(req) {
      return toSaveResult((await request('saveAs', toSaveArgs(req))).result);
    },

    async openFolder() {
      const { result, files } = await request                                             ('openFolder');
      if (!result) return null;
      return { name: result.name, files: [...(result.files ?? []).map(fromWire), ...files] };
    },

    async reload(file) {
      if (!file.path) return null;
      const { result } = await request                 ('reload', { path: file.path });
      return result ? fromWire(result) : null;
    },

    setTitle(title) {
      bridge.postMessage({ kind: 'setTitle', title: String(title) });
    },

    onBeforeClose(handler) {
      closeHandler = handler;
    },

    onOpenRequest(handler) {
      openHandler = handler;
      for (const files of queuedOpens.splice(0)) handler(files);
      bridge.postMessage({ kind: 'ready' });
    },
  };
}

/**
 * Explorer drops. A File from a DOM drop has no path, so a document opened
 * that way could never be saved back in place. WebView2 can pass the File
 * objects themselves to the host, where they arrive as CoreWebView2File with
 * the full path; the exe then reads them and answers with an openRequest,
 * exactly like files on the command line.
 *
 * Capture phase on the window, so this wins over any drop handling the page
 * does for the browser build, and only for drags that carry files, so text
 * dragged within the editor is untouched.
 */
function installDrop(target             , bridge               )       {
  const carriesFiles = (event       )                      => {
    const transfer = (event             ).dataTransfer;
    if (!transfer) return null;
    return Array.from(transfer.types ?? []).includes('Files') ? transfer : null;
  };
  target.addEventListener('dragover', (event) => {
    const transfer = carriesFiles(event);
    if (!transfer) return;
    event.preventDefault();
    transfer.dropEffect = 'copy';
  }, true);
  target.addEventListener('drop', (event) => {
    const transfer = carriesFiles(event);
    if (!transfer || transfer.files.length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    bridge.postMessageWithAdditionalObjects ({ kind: 'drop' }, transfer.files);
  }, true);
}

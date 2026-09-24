/**
 * ArchPad's Host in a browser.
 *
 * Where the File System Access API exists (Chromium: Edge, Chrome), files are
 * opened and saved through handles, so Save writes back to the same file on
 * disk the way a desktop editor does. Elsewhere (Firefox, Safari, a file://
 * page in some configurations) opening falls back to a hidden file input and
 * saving to a download — the browser's own Save As, in effect.
 *
 * Files also arrive from outside: the toolkit's "Open in ArchPad" leaves a
 * handoff in storage for a fresh tab and talks to an already-open tab over a
 * BroadcastChannel (see handoff.ts for the protocol).
 */

                                                                            
import { CHANNEL_NAME, parseMessage, randomId, takeStoredHandoff,                                       } from './handoff.js';

/*
 * The File System Access API is not in every TypeScript DOM lib, so the few
 * members used here are declared locally rather than pulled from a package.
 */
                      
                                                           
                         
 
                        
                        
                        
                           
                                         
                                                                                      
                                                                                        
 
                             
                             
                        
                                                            
 
                    
                                                                                 
                                                                                   
                                                                                              
 

/**
 * Limits for Open Folder (Find in Files). A folder can be a repository with a
 * node_modules in it; reading all of it into memory would hang the tab, so
 * big files, binary-ish folders and anything past the caps are skipped.
 */
export const FOLDER_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxFiles: 10_000,
  skipDirectories: new Set(['.git', 'node_modules', '.svn', '.hg', 'bin', 'obj', '.vs', '__pycache__', '.venv', 'dist']),
}         ;

const encoder = new TextEncoder();

/** Text from the toolkit becomes bytes, because the core decodes every file itself. */
export function handoffToOpened(files                        , now         = Date.now())               {
  return files.map((f) => ({ name: f.name, bytes: encoder.encode(f.text), lastModified: now }));
}

function isAbort(error         )          {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NotAllowedError');
}

function fsWindow()           {
  return globalThis                       ;
}

function isFileHandle(value         )                        {
  return typeof value === 'object' && value !== null && (value                ).kind === 'file' && typeof (value                ).getFile === 'function';
}

async function fromFile(file      , handle               , path         )                      {
  return {
    name: file.name,
    path,
    bytes: new Uint8Array(await file.arrayBuffer()),
    handle,
    lastModified: file.lastModified,
  };
}

/** The pre-API route: a hidden `<input type=file>`. Resolves [] on cancel where the browser says so. */
function pickWithInput(options                                             )                  {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple ?? true;
    if (options.directory) input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    let settled = false;
    const done = (files        ) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]));
    // 'cancel' is recent; without it a cancelled dialog leaves the promise
    // pending, which is harmless — nothing waits on it but the click.
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

function download(name        , bytes            )       {
  const blob = new Blob([bytes            ], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked later, not now: some browsers start the download asynchronously.
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function writeTo(handle              , bytes            )                   {
  if (typeof handle.createWritable !== 'function') return false;
  if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if (!handle.requestPermission || (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
  }
  const writable = await handle.createWritable();
  await writable.write(bytes                );
  await writable.close();
  return true;
}

async function walk(
  dir                   ,
  prefix        ,
  out              ,
  budget                   ,
)                {
  for await (const entry of dir.values()) {
    if (out.length >= FOLDER_LIMITS.maxFiles || budget.bytes >= FOLDER_LIMITS.maxTotalBytes) return;
    const path = `${prefix}/${entry.name}`;
    if (entry.kind === 'directory') {
      if (FOLDER_LIMITS.skipDirectories.has(entry.name)) continue;
      await walk(entry, path, out, budget);
      continue;
    }
    try {
      const file = await entry.getFile();
      if (file.size > FOLDER_LIMITS.maxFileBytes || budget.bytes + file.size > FOLDER_LIMITS.maxTotalBytes) continue;
      budget.bytes += file.size;
      out.push(await fromFile(file, entry, path));
    } catch {
      // A file locked or removed mid-walk is skipped, not fatal.
    }
  }
}

/**
 * Files from Open Folder carry `path` as the path inside the chosen folder
 * ("project/src/app.ts"): the browser never reveals the real disk path, and
 * Find in Files needs something to tell two README.md files apart.
 */
export function createBrowserHost()       {
  let openHandler                                         = null;
  // Files that arrived before the core registered its handler.
  const pending                 = [];
  const tabId = randomId();

  const deliver = (files              ) => {
    if (files.length === 0) return;
    if (openHandler) openHandler(files);
    else pending.push(files);
  };

  // An open ArchPad tab answers the toolkit's ping, but only once the editor
  // has registered to receive files — before that, the sender is better off
  // opening a new tab than posting into a page still loading.
  const Channel = globalThis.BroadcastChannel;
  if (typeof Channel === 'function') {
    const channel = new Channel(CHANNEL_NAME);
    channel.onmessage = (event              ) => {
      const msg = parseMessage(event.data);
      if (!msg || !openHandler) return;
      if (msg.type === 'ping') {
        channel.postMessage({ type: 'pong', id: msg.id, tab: tabId }                         );
      } else if (msg.type === 'open' && msg.tab === tabId) {
        deliver(handoffToOpened(msg.files));
      }
    };
  }

  const host       = {
    kind: 'browser',

    async openFiles() {
      const w = fsWindow();
      if (typeof w.showOpenFilePicker === 'function') {
        try {
          const handles = await w.showOpenFilePicker({ multiple: true });
          return Promise.all(handles.map(async (h) => fromFile(await h.getFile(), h)));
        } catch (error) {
          if (isAbort(error)) return [];
          throw error;
        }
      }
      const files = await pickWithInput({ multiple: true });
      return Promise.all(files.map((f) => fromFile(f)));
    },

    async save(request             ) {
      if (isFileHandle(request.handle)) {
        try {
          if (await writeTo(request.handle, request.bytes)) {
            return { name: request.handle.name, handle: request.handle }                     ;
          }
        } catch (error) {
          if (!isAbort(error)) throw error;
        }
        // Permission refused: fall through to Save As rather than lose the edit.
      }
      return host.saveAs(request);
    },

    async saveAs(request             ) {
      const w = fsWindow();
      if (typeof w.showSaveFilePicker === 'function') {
        try {
          const handle = await w.showSaveFilePicker({ suggestedName: request.name });
          await writeTo(handle, request.bytes);
          return { name: handle.name, handle }                     ;
        } catch (error) {
          if (isAbort(error)) return null;
          throw error;
        }
      }
      // No handle to keep: every later Save downloads again, which is the most
      // a browser without the API allows.
      download(request.name, request.bytes);
      return { name: request.name }                     ;
    },

    async openFolder() {
      const w = fsWindow();
      if (typeof w.showDirectoryPicker === 'function') {
        try {
          const dir = await w.showDirectoryPicker({ mode: 'read' });
          const files               = [];
          await walk(dir, dir.name, files, { bytes: 0 });
          return { name: dir.name, files };
        } catch (error) {
          if (isAbort(error)) return null;
          throw error;
        }
      }
      const picked = await pickWithInput({ multiple: true, directory: true });
      if (picked.length === 0) return null;
      const files               = [];
      let bytes = 0;
      for (const f of picked) {
        if (files.length >= FOLDER_LIMITS.maxFiles) break;
        const rel = (f                                          ).webkitRelativePath || f.name;
        if (rel.split('/').some((part) => FOLDER_LIMITS.skipDirectories.has(part))) continue;
        if (f.size > FOLDER_LIMITS.maxFileBytes || bytes + f.size > FOLDER_LIMITS.maxTotalBytes) continue;
        bytes += f.size;
        files.push(await fromFile(f, undefined, rel));
      }
      const root = ((picked[0]                                          ).webkitRelativePath || '').split('/')[0] || 'folder';
      return { name: root, files };
    },

    async reload(file) {
      if (!isFileHandle(file.handle)) return null;
      try {
        return await fromFile(await file.handle.getFile(), file.handle, file.path);
      } catch {
        return null;
      }
    },

    setTitle(title        ) {
      document.title = title;
    },

    onBeforeClose(handler) {
      globalThis.addEventListener('beforeunload', (event                   ) => {
        const result = handler();
        // beforeunload cannot wait for a promise; an asynchronous answer is
        // treated as "keep it open" so unsaved work is never lost silently.
        if (result === false || result instanceof Promise) {
          event.preventDefault();
          event.returnValue = '';
        }
      });
    },

    onOpenRequest(handler) {
      openHandler = handler;
      for (const files of pending.splice(0)) handler(files);
      deliver(handoffToOpened(takeStoredHandoff()));
    },
  };

  return host;
}

/**
 * ArchPad filling the whole window (web/archpad/index.html) — the page
 * ArchPad.exe loads into WebView2.
 *
 * Inside the exe, `window.chrome.webview` exists and the C# side owns the
 * dialogs and the disk, so the exe host is used. The same page opened in an
 * ordinary browser (for testing the app layout, or on a machine without the
 * exe) falls back to the browser host rather than failing.
 */

import { mountArchPad } from './app.js';
import { createBrowserHost } from './host-browser.js';
import { createExeHost } from './host-exe.js';
import { TOOL_COMMANDS } from './tools/index.js';
                                       

                         
                                                   
 

function pickHost()       {
  return (globalThis                            ).chrome?.webview ? createExeHost() : createBrowserHost();
}

const root = document.getElementById('archpad-root');
if (root) {
  mountArchPad(root, pickHost(), { commands: TOOL_COMMANDS, layout: 'app' });
}

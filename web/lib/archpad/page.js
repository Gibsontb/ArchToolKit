/**
 * ArchPad as a toolkit page (web/app/archpad.html): the editor below the
 * toolkit's header, saving through the browser.
 */

import { mountArchPad } from './app.js';
import { createBrowserHost } from './host-browser.js';
import { TOOL_COMMANDS } from './tools/index.js';

const root = document.getElementById('archpad-root');
if (root) {
  mountArchPad(root, createBrowserHost(), { commands: TOOL_COMMANDS, layout: 'page' });
}

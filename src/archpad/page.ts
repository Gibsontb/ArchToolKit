/**
 * ArchPad as a toolkit page (web/app/archpad.html): the editor below the
 * toolkit's header, saving through the browser.
 */

import { mountArchPad } from './app.ts';
import { createBrowserHost } from './host-browser.ts';
import { TOOL_COMMANDS } from './tools/index.ts';

const root = document.getElementById('archpad-root');
if (root) {
  mountArchPad(root, createBrowserHost(), { commands: TOOL_COMMANDS, layout: 'page' });
}

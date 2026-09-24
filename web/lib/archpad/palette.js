/**
 * The command palette (Ctrl+Shift+P): every menu command, tool and language
 * in one filterable list, run with Enter.
 *
 * Matching is by words in any order ("json fmt" finds "Tools › JSON ›
 * Format"), with a bonus for matches at word starts, so short queries land
 * on the command you meant without a fuzzy-search library.
 */

import { el, replace } from '../ui/dom.js';
import { displayShortcut } from './shortcuts.js';

                              
                         
                                                                    
                           
                             
                           
 

/** Score an item against the query; -1 when a word is missing. Pure, for tests. */
export function paletteScore(query        , label        , detail = '')         {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const hay = `${detail} ${label}`.toLowerCase();
  const own = label.toLowerCase();
  let score = 0;
  for (const w of words) {
    const at = hay.indexOf(w);
    if (at < 0) return -1;
    score += 1;
    if (own.includes(w)) score += 2;
    if (at === 0 || /[\s›/(.-]/.test(hay[at - 1] ?? '')) score += 2;
    if (own.startsWith(w)) score += 3;
  }
  return score;
}

let open                           = null;

export function openPalette(host             , items                        , onClose             )       {
  if (open) {
    open.close();
    open.remove();
    open = null;
  }
  const dialog = el('dialog', { class: 'ap-palette', attrs: { 'aria-label': 'Command palette' } })                     ;
  const input = el('input', { class: 'ap-input', attrs: { type: 'text', spellcheck: 'false', placeholder: 'Type a command, tool or language…', 'aria-label': 'Command' } })                    ;
  const list = el('div', { class: 'ap-palette-list', attrs: { role: 'listbox' } });
  let shown                = [];
  let active = 0;

  let done = false;
  // Cleaned up directly rather than only from the 'close' event, which a
  // backgrounded page may deliver late.
  const cleanup = ()       => {
    if (done) return;
    done = true;
    dialog.remove();
    if (open === dialog) open = null;
    onClose?.();
  };
  const close = ()       => {
    if (dialog.open) dialog.close();
    cleanup();
  };
  dialog.addEventListener('close', cleanup);

  const choose = (item                         )       => {
    if (!item) return;
    close();
    // After the dialog is gone, so the command sees the editor focused.
    setTimeout(() => item.run(), 0);
  };

  const paint = ()       => {
    const rows = shown.slice(0, 200).map((item, i) => {
      const row = el(
        'div',
        { class: `ap-palette-item${i === active ? ' is-active' : ''}`, attrs: { role: 'option', 'aria-selected': i === active ? 'true' : 'false' } },
        el('span', { class: 'ap-palette-label', text: item.label }),
        item.detail ? el('span', { class: 'ap-palette-detail', text: item.detail }) : null,
        item.shortcut ? el('kbd', { class: 'ap-palette-key', text: displayShortcut(item.shortcut) }) : null,
      );
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        choose(item);
      });
      return row;
    });
    replace(list, ...(rows.length ? rows : [el('div', { class: 'ap-palette-empty', text: 'No matching commands' })]));
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  const filter = ()       => {
    const q = input.value.trim();
    shown = items
      .map((item, i) => ({ item, i, s: paletteScore(q, item.label, item.detail) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.item);
    active = 0;
    paint();
  };

  input.addEventListener('input', filter);
  dialog.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + Math.min(shown.length, 200)) % Math.min(shown.length, 200);
      paint();
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      active = Math.max(0, Math.min(Math.min(shown.length, 200) - 1, active + (e.key === 'PageDown' ? 10 : -10)));
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  dialog.addEventListener('mousedown', (e) => {
    if (e.target === dialog) close();
  });

  dialog.append(input, list);
  host.appendChild(dialog);
  open = dialog;
  dialog.showModal();
  filter();
  input.focus();
}

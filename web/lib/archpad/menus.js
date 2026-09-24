/**
 * The menu bar and context menus.
 *
 * Menus are built from functions at the moment they open, so check marks
 * (word wrap, the current encoding), the recent files list and the window
 * list are always current without any bookkeeping.
 */

import { el } from '../ui/dom.js';
import { displayShortcut } from './shortcuts.js';

                      
     
                             
                                 
                                
                                 
                                                                                       
                               
                                  
                                                   
                              
     
                

                          
                         
                                                                             
                             
                                            
 

                     
                           
                                                            
                 
 

/**
 * One stack of open popups (a menu and its submenus). Shared by the bar and
 * context menus so only one thing is ever open.
 */
class PopupStack {
          levels              = [];
  onClose                      = null;
                   host             ;

  constructor(host             ) {
    this.host = host;
    document.addEventListener(
      'mousedown',
      (e) => {
        if (!this.levels.length) return;
        const target = e.target        ;
        if (this.levels.some((l) => l.el.contains(target))) return;
        if ((target               ).closest?.('.ap-menubar-item')) return;
        this.closeAll();
      },
      true,
    );
    window.addEventListener('blur', () => this.closeAll());
    window.addEventListener('resize', () => this.closeAll());
  }

  get isOpen()          {
    return this.levels.length > 0;
  }

  closeAll()       {
    for (const l of this.levels) l.el.remove();
    const wasOpen = this.levels.length > 0;
    this.levels = [];
    if (wasOpen) this.onClose?.();
  }

          closeFrom(depth        )       {
    for (const l of this.levels.splice(depth)) l.el.remove();
  }

  open(items                     , x        , y        , depth = 0, alignRightOf          )       {
    this.closeFrom(depth);
    const real = items.filter((i)                                      => i !== 'separator');
    const menu = el('div', { class: 'ap-menu', attrs: { role: 'menu' } });
    const level            = { el: menu, items: real, active: -1 };
    let index = 0;
    items.forEach((item, i) => {
      if (item === 'separator') {
        // No separator at the top, bottom, or twice in a row.
        if (i > 0 && i < items.length - 1 && items[i - 1] !== 'separator') menu.appendChild(el('div', { class: 'ap-menu-sep', attrs: { role: 'separator' } }));
        return;
      }
      const my = index++;
      const row = el(
        'div',
        {
          class: `ap-menu-item${item.disabled ? ' is-disabled' : ''}${item.submenu ? ' has-sub' : ''}`,
          attrs: { role: 'menuitem', 'aria-disabled': item.disabled ? 'true' : null, title: item.title ?? null, 'data-index': my },
        },
        el('span', { class: 'ap-menu-check', text: item.checked ? (item.radio ? '●' : '✓') : '' }),
        el('span', { class: 'ap-menu-label', text: item.label }),
        el('span', { class: 'ap-menu-key', text: item.shortcut ? displayShortcut(item.shortcut) : '' }),
        el('span', { class: 'ap-menu-arrow', text: item.submenu ? '›' : '' }),
      );
      row.addEventListener('mouseenter', () => this.activate(level, depth, my, true));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.choose(level, depth, my);
      });
      menu.appendChild(row);
    });
    if (!real.length) menu.appendChild(el('div', { class: 'ap-menu-item is-disabled' }, el('span', { class: 'ap-menu-check' }), el('span', { class: 'ap-menu-label', text: '(empty)' })));
    this.host.appendChild(menu);
    this.levels.push(level);
    // Keep the popup on screen: flip left of the parent, or up, when there is no room.
    const r = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 4) left = alignRightOf ? alignRightOf.left - r.width : window.innerWidth - r.width - 4;
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
    menu.style.left = `${Math.max(4, left)}px`;
    menu.style.top = `${Math.max(4, top)}px`;
  }

          activate(level           , depth        , index        , fromMouse         )       {
    level.active = index;
    level.el.querySelectorAll('.ap-menu-item').forEach((row) => row.classList.toggle('is-active', Number((row               ).dataset['index']) === index));
    const item = level.items[index];
    if (item?.submenu && !item.disabled) {
      const row = level.el.querySelector             (`[data-index="${index}"]`) ;
      const rect = row.getBoundingClientRect();
      this.open(item.submenu(), rect.right - 2, rect.top - 4, depth + 1, rect);
    } else if (fromMouse) this.closeFrom(depth + 1);
  }

          choose(level           , depth        , index        )       {
    const item = level.items[index];
    if (!item || item.disabled) return;
    if (item.submenu) {
      this.activate(level, depth, index, false);
      const sub = this.levels[depth + 1];
      if (sub) this.activate(sub, depth + 1, 0, false);
      return;
    }
    this.closeAll();
    item.run?.();
  }

  /** Arrow keys, Enter and Escape while a menu is open. Returns true when it used the key. */
  key(e               , moveTop                       )          {
    if (!this.levels.length) return false;
    const depth = this.levels.length - 1;
    const level = this.levels[depth] ;
    const n = level.items.length;
    const step = (dir        )       => {
      if (!n) return;
      let i = level.active;
      for (let k = 0; k < n; k++) {
        i = (i + dir + n) % n;
        if (!level.items[i] .disabled) break;
      }
      this.activate(level, depth, i, true);
    };
    switch (e.key) {
      case 'ArrowDown':
        step(1);
        return true;
      case 'ArrowUp':
        step(-1);
        return true;
      case 'ArrowRight':
        if (level.items[level.active]?.submenu) this.choose(level, depth, level.active);
        else moveTop(1);
        return true;
      case 'ArrowLeft':
        if (depth > 0) this.closeFrom(depth);
        else moveTop(-1);
        return true;
      case 'Enter':
      case ' ':
        if (level.active >= 0) this.choose(level, depth, level.active);
        return true;
      case 'Escape':
        if (depth > 0) this.closeFrom(depth);
        else this.closeAll();
        return true;
      default:
        return false;
    }
  }
}

                          
                                
                                                        
                                          
                                              
                                                                  
                                             
                                       
                           
                
 

export function createMenuBar(host             , menus                    )          {
  const stack = new PopupStack(host);
  const bar = el('div', { class: 'ap-menubar', attrs: { role: 'menubar' } });
  let openIndex = -1;
  const buttons                      = [];

  const openAt = (i        )       => {
    const menu = menus[i];
    const button = buttons[i];
    if (!menu || !button) return;
    stack.closeAll();
    openIndex = i;
    buttons.forEach((b, k) => b.classList.toggle('is-open', k === i));
    const r = button.getBoundingClientRect();
    stack.open(menu.items(), r.left, r.bottom);
  };
  stack.onClose = () => {
    openIndex = -1;
    buttons.forEach((b) => b.classList.remove('is-open'));
  };

  menus.forEach((menu, i) => {
    const button = el('button', { class: 'ap-menubar-item', text: menu.label, attrs: { type: 'button', role: 'menuitem', tabindex: -1 } })                     ;
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (openIndex === i) stack.closeAll();
      else openAt(i);
    });
    // Sliding along the bar with a menu open switches menus, as on Windows.
    button.addEventListener('mouseenter', () => {
      if (openIndex >= 0 && openIndex !== i) openAt(i);
    });
    buttons.push(button);
    bar.appendChild(button);
  });

  return {
    element: bar,
    get isOpen() {
      return stack.isOpen;
    },
    openByMnemonic(letter) {
      const i = menus.findIndex((m) => m.mnemonic?.toLowerCase() === letter.toLowerCase());
      if (i < 0) return false;
      openAt(i);
      return true;
    },
    context(items, x, y) {
      stack.closeAll();
      stack.open(items, x, y);
    },
    handleKey(e) {
      return stack.key(e, (dir) => {
        if (openIndex >= 0) openAt((openIndex + dir + menus.length) % menus.length);
      });
    },
    close() {
      stack.closeAll();
    },
  };
}

/**
 * A placeholder pane: its title, what it will do, and a line saying it is
 * being built (and by which work package). The shells mount the real pane
 * modules through the same `mount(root, ctx)` contract, so replacing a stub is
 * replacing its module's body; nothing in the shell changes.
 */

import { el, append } from './dom.js';
import { card } from './components.js';
                                                   

                           
                         
                                                     
                        
                                      
                         
                                                                                    
                                          
 

export function stubPane(root             , ctx             , spec          )       {
  const argLine = el('p', { class: 'small muted', attrs: { 'data-control': 'pane-arg' } });
  const showArg = (arg        ) => {
    argLine.textContent = arg ? `Opened with: ${arg}` : '';
    argLine.style.display = arg ? '' : 'none';
  };
  showArg(ctx.arg());
  ctx.onArg(showArg);
  append(
    root,
    card(
      spec.title,
      el('p', { text: spec.does }),
      argLine,
      ...(spec.extra ?? []),
      el('p', {
        class: 'section-note',
        attrs: { 'data-control': 'pane-stub' },
        text: `This pane is being built (${spec.owner}). The plan it reads and writes is already shared by both pages.`,
      }),
    ),
  );
}

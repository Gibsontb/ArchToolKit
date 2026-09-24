/**
 * ArchPad's dialogs: a promise-based modal (prompt, confirm with three
 * answers, pick from a list, small forms) built on <dialog>.
 *
 * window.prompt/confirm are avoided on purpose: WebView2 shows them with a
 * browser-looking frame, they block the event loop (autosave stops), and they
 * cannot offer "Save / Don't Save / Cancel".
 */

import { el,            } from '../ui/dom.js';

                                  
                         
                    
                             
                            
 

                                   
                         
                                 
                                               
                                                   
                          
                                                                          
                             
                          
                                                                                             
                                            
 

export function openDialog   (options                  )             {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: `ap-dialog${options.wide ? ' ap-dialog-wide' : ''}`, attrs: { 'aria-label': options.title } })                     ;
    let done = false;
    const finish = (value   )       => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const body = el('div', { class: 'ap-dialog-body' }, ...(Array.isArray(options.body) ? options.body : [options.body]));
    const buttons = el(
      'div',
      { class: 'ap-dialog-buttons' },
      ...options.buttons.map((b) =>
        el('button', {
          class: `ap-btn${b.primary ? ' ap-btn-primary' : ''}${b.danger ? ' ap-btn-danger' : ''}`,
          text: b.label,
          attrs: { type: 'button' },
          on: {
            click: () => {
              if (options.validate && !options.validate(b.value)) return;
              finish(b.value);
            },
          },
        }),
      ),
    );
    dialog.append(
      el(
        'div',
        { class: 'ap-dialog-head' },
        el('strong', { text: options.title }),
        el('button', { class: 'ap-x', text: '×', attrs: { type: 'button', 'aria-label': 'Close' }, on: { click: () => finish(options.cancelValue) } }),
      ),
      body,
      buttons,
    );
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(options.cancelValue);
    });
    dialog.addEventListener('keydown', (e) => {
      // Enter in a single-line field presses the primary button.
      if (e.key === 'Enter' && (e.target               ).tagName === 'INPUT' && !e.isComposing) {
        const primary = options.buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          if (options.validate && !options.validate(primary.value)) return;
          finish(primary.value);
        }
      }
      e.stopPropagation();
    });
    options.host.appendChild(dialog);
    dialog.showModal();
    const focus = body.querySelector             ('input, select, textarea') ?? buttons.querySelector             ('.ap-btn-primary');
    focus?.focus();
    if (focus instanceof HTMLInputElement) focus.select();
  });
}

export async function promptDialog(host             , title        , label        , initial = '')                         {
  const input = el('input', { class: 'ap-input', attrs: { type: 'text', spellcheck: 'false' } })                    ;
  input.value = initial;
  const ok = await openDialog({
    host,
    title,
    body: [el('label', { class: 'ap-field' }, el('span', { text: label }), input)],
    buttons: [
      { label: 'OK', value: true, primary: true },
      { label: 'Cancel', value: false },
    ],
    cancelValue: false,
  });
  return ok ? input.value : null;
}

export function messageDialog(host             , title        , message                 )                {
  return openDialog({ host, title, body: message, buttons: [{ label: 'OK', value: undefined, primary: true }], cancelValue: undefined });
}

export function confirmDialog(host             , title        , message        , okLabel = 'OK')                   {
  return openDialog({
    host,
    title,
    body: el('p', { text: message }),
    buttons: [
      { label: okLabel, value: true, primary: true },
      { label: 'Cancel', value: false },
    ],
    cancelValue: false,
  });
}

                                                       

/** Notepad++'s "Save file?" question. */
export function saveChangesDialog(host             , name        )                      {
  return openDialog            ({
    host,
    title: 'Save',
    body: el('p', { text: `Save changes to "${name}"?` }),
    buttons: [
      { label: 'Save', value: 'save', primary: true },
      { label: "Don't Save", value: 'discard', danger: true },
      { label: 'Cancel', value: 'cancel' },
    ],
    cancelValue: 'cancel',
  });
}

/** Pick one of several items; null when cancelled. */
export async function pickDialog   (host             , title        , label        , items                                        , selected = 0)                    {
  const select = el('select', { class: 'ap-input', attrs: { size: Math.min(12, Math.max(4, items.length)) } }, ...items.map((it, i) => el('option', { text: it.label, attrs: { value: String(i) } })))                     ;
  select.selectedIndex = Math.max(0, Math.min(items.length - 1, selected));
  select.addEventListener('dblclick', () => (select.closest('dialog')?.querySelector('.ap-btn-primary')                            )?.click());
  const ok = await openDialog({
    host,
    title,
    body: [el('label', { class: 'ap-field' }, el('span', { text: label }), select)],
    buttons: [
      { label: 'OK', value: true, primary: true },
      { label: 'Cancel', value: false },
    ],
    cancelValue: false,
  });
  return ok && select.selectedIndex >= 0 ? items[select.selectedIndex] .value : null;
}

/** A labelled row for form dialogs. */
export function field(label        , control             , hint         )              {
  return el('label', { class: 'ap-field' }, el('span', { text: label }), control, hint ? el('small', { class: 'ap-hint', text: hint }) : null);
}

export function textInput(value = '', attrs                                  = {})                   {
  const input = el('input', { class: 'ap-input', attrs: { type: 'text', spellcheck: 'false', ...attrs } })                    ;
  input.value = value;
  return input;
}

export function checkbox(label        , checked = false)                                                {
  const input = el('input', { attrs: { type: 'checkbox' } })                    ;
  input.checked = checked;
  return { row: el('label', { class: 'ap-check' }, input, el('span', { text: label })), input };
}

export function radioGroup                  (name        , options                                        , selected   )                                       {
  const inputs = options.map((o) => {
    const input = el('input', { attrs: { type: 'radio', name, value: o.value } })                    ;
    input.checked = o.value === selected;
    return { input, row: el('label', { class: 'ap-check' }, input, el('span', { text: o.label })) };
  });
  return {
    row: el('div', { class: 'ap-radios' }, ...inputs.map((i) => i.row)),
    value: () => (inputs.find((i) => i.input.checked)?.input.value                 ) ?? selected,
  };
}

export function selectInput                  (options                                        , selected   )                    {
  const select = el('select', { class: 'ap-input' }, ...options.map((o) => el('option', { text: o.label, attrs: { value: o.value } })))                     ;
  select.value = selected;
  return select;
}

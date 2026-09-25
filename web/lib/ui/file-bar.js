/**
 * Load, Save and Clear for a page's form.
 *
 * The same strip on the spec builder and both generators: Load a settings
 * file (JSON, YAML or TXT), Save the form as one, in the format picked beside
 * the button, and Clear the form back to where the page starts. Clear here is
 * this page's form only; the header's Clear all is the whole toolkit.
 */

import { el, downloadFile, readFileAsText } from './dom.js';
import { readSettings, SETTINGS_FORMATS, writeSettings,                     } from '../kit/settings-file.js';
                                             

const FORMAT_KEY = 'archtoolkit.settings-format';

                                 
                                                           
                        
                                     
                                  
                                                            
                            
                                                                                
                                            
                                                                                         
                                                       
                                                    
                             
 

function rememberedFormat()                 {
  try {
    const f = globalThis.sessionStorage?.getItem(FORMAT_KEY);
    if (f === 'json' || f === 'yaml' || f === 'txt') return f;
  } catch {
    // No storage: JSON it is.
  }
  return 'json';
}

export function fileBar(options                )              {
  const status = el('span', { class: 'file-bar-status small', attrs: { role: 'status', 'data-control': 'settings-status' } });
  const say = (text        , tone                    = '') => {
    status.textContent = text;
    status.className = `file-bar-status small${tone ? ` is-${tone}` : ''}`;
  };

  const picker = el('input', {
    attrs: { type: 'file', accept: '.json,.yaml,.yml,.txt,application/json,text/yaml,text/plain', hidden: 'hidden', 'data-control': 'settings-file' },
  })                    ;
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    void readFileAsText(file).then((text) => {
      try {
        say(options.load(readSettings(text, file.name), file.name), 'ok');
      } catch (err) {
        say(`Not loaded — ${(err         ).message}`, 'bad');
      }
    });
  });

  const format = el('select', { attrs: { 'aria-label': 'Save as', 'data-control': 'settings-format' } })                     ;
  for (const f of SETTINGS_FORMATS) format.appendChild(el('option', { text: f.label, attrs: { value: f.value } }));
  format.value = rememberedFormat();
  format.addEventListener('change', () => {
    try {
      globalThis.sessionStorage?.setItem(FORMAT_KEY, format.value);
    } catch {
      // Remembering the choice is a nicety.
    }
  });

  let armed                                           ;
  const clearButton = el('button', {
    class: 'btn',
    text: 'Clear',
    attrs: { type: 'button', title: `Clear this page's form back to its defaults`, 'data-control': 'settings-clear' },
  })                     ;
  clearButton.addEventListener('click', () => {
    if (!armed) {
      clearButton.textContent = 'Click again to clear the form';
      clearButton.classList.add('is-armed');
      armed = setTimeout(() => {
        armed = undefined;
        clearButton.textContent = 'Clear';
        clearButton.classList.remove('is-armed');
      }, 5000);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    clearButton.textContent = 'Clear';
    clearButton.classList.remove('is-armed');
    options.clear();
    say('Cleared.');
  });

  return el(
    'div',
    { class: 'file-bar' },
    el('button', {
      class: 'btn',
      text: 'Load settings…',
      attrs: { type: 'button', title: `Load ${options.noun} from a JSON, YAML or TXT file`, 'data-control': 'settings-load' },
      on: { click: () => picker.click() },
    }),
    el('button', {
      class: 'btn btn-primary',
      text: 'Save settings',
      attrs: { type: 'button', title: `Save ${options.noun} to a file, to load again later — the form's values, not the generated output`, 'data-control': 'settings-save' },
      on: {
        click: () => {
          const f = format.value                  ;
          const ext = SETTINGS_FORMATS.find((x) => x.value === f)?.extension ?? '.json';
          downloadFile(`${options.fileName()}${ext}`, writeSettings(options.save(), f, options.header?.() ?? []), f === 'json' ? 'application/json' : f === 'yaml' ? 'application/yaml' : 'text/plain');
          say(`Saved as ${f.toUpperCase()}.`, 'ok');
        },
      },
    }),
    format,
    clearButton,
    picker,
    status,
  );
}

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

                                 
                                                           
                        
                                     
                                  
                                                            
                            
                                                                                
                                            
                                                                                         
                                                       
                                                    
                             
     
                                                                             
                                                                          
                                                                         
     
                                                       
 

/** The page's main file action: its button, the files it accepts, and what it does with one. */
                              
                         
                         
                                             
                          
                                                                                   
                                                 
 

const REFRESH = new WeakMap                         ();

/** Ask the bar again whether its page opens a file of its own (after the page changes what it builds). */
export function refreshFileBar(bar             )       {
  REFRESH.get(bar)?.();
}

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
  const loadSettingsFile = (file      )       => {
    void readFileAsText(file).then((text) => {
      try {
        say(options.load(readSettings(text, file.name), file.name), 'ok');
      } catch (err) {
        say(`Not loaded — ${(err         ).message}`, 'bad');
      }
    });
  };
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    loadSettingsFile(file);
  });

  // The page's own file (a dashboard), when it has one: its own picker.
  const primaryPicker = el('input', { attrs: { type: 'file', hidden: 'hidden', 'data-control': 'primary-file' } })                    ;
  let primary                         ;
  primaryPicker.addEventListener('change', () => {
    const file = primaryPicker.files?.[0];
    primaryPicker.value = '';
    if (!file || !primary) return;
    const current = primary;
    void (async () => {
      // A settings file chosen here still loads as one; anything else is the page's own file.
      if (/\.(ya?ml|txt)$/i.test(file.name)) {
        loadSettingsFile(file);
        return;
      }
      if (/\.json$/i.test(file.name)) {
        const text = await readFileAsText(file);
        if (!/"dashboards"\s*:/.test(text)) {
          try {
            say(options.load(readSettings(text, file.name), file.name), 'ok');
            return;
          } catch {
            // Not a settings file: open it as the page's own.
          }
        }
      }
      say(`Reading ${file.name}…`);
      try {
        say(await current.open(file), 'ok');
      } catch (err) {
        say(`Not loaded — ${(err         ).message}`, 'bad');
      }
    })();
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

  const primaryButton = el('button', { class: 'btn btn-primary', attrs: { type: 'button', hidden: 'hidden', 'data-control': 'primary-load' }, on: { click: () => primaryPicker.click() } })                     ;
  const formLabel = el('span', { class: 'file-bar-label small muted', text: 'Form answers:', attrs: { hidden: 'hidden' } });
  const loadButton = el('button', {
    class: 'btn',
    text: 'Load settings…',
    attrs: { type: 'button', title: `Load ${options.noun} from a JSON, YAML or TXT file`, 'data-control': 'settings-load' },
    on: { click: () => picker.click() },
  })                     ;
  const saveButton = el('button', {
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
    })                     ;

  const bar = el('div', { class: 'file-bar' }, primaryButton, formLabel, loadButton, saveButton, format, clearButton, picker, primaryPicker, status);
  const refresh = ()       => {
    primary = options.primaryFile?.();
    // .btn sets display, which the hidden attribute alone does not beat.
    primaryButton.hidden = !primary;
    primaryButton.style.display = primary ? '' : 'none';
    formLabel.hidden = !primary;
    formLabel.style.display = primary ? '' : 'none';
    if (primary) {
      primaryButton.textContent = primary.label;
      primaryButton.title = primary.title;
      primaryPicker.accept = primary.accept;
    }
    // With a file of its own, saving and loading the form's answers is the lesser action.
    loadButton.textContent = primary ? 'Load…' : 'Load settings…';
    saveButton.textContent = primary ? 'Save' : 'Save settings';
    saveButton.className = primary ? 'btn' : 'btn btn-primary';
    loadButton.title = primary ? `Load this form's answers from a settings file you saved (JSON, YAML or TXT) — not a dashboard: ${primary.label.replace(/…$/, '')} opens those` : `Load ${options.noun} from a JSON, YAML or TXT file`;
    saveButton.title = primary ? 'Save this form’s answers (not a dashboard) to a settings file, to load again later' : `Save ${options.noun} to a file, to load again later — the form's values, not the generated output`;
  };
  REFRESH.set(bar, refresh);
  refresh();
  return bar;
}

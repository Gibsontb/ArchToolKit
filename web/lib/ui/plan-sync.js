/**
 * One plan, two pages, any number of tabs.
 *
 * Application Migration and Multi-Cloud Migration & Utilities both hold the
 * same `Plan` (IndexedDB store `plan`, key `current`). This keeps a page's copy
 * honest (addendum A.1.1):
 *
 * 1. Saves are conditional: `savePlanIfUnchanged(plan, basedOnSavedAt)` writes
 *    only when the stored `savedAt` is still the one this page loaded.
 * 2. Every save is announced on `BroadcastChannel('archtoolkit.plan')` (store.ts
 *    does that), and this listens through `onPlanSaved`.
 * 3. When another page saves: with no unsaved edits here, the plan reloads
 *    silently; with unsaved edits, the conflict banner asks — Reload (the
 *    unsaved change is lost) or Keep mine (overwrites). A save that comes back
 *    'conflict' raises the same banner. Neither page ever silently loses the
 *    other's work.
 *
 * The session is built over a small store interface so the rules are tested
 * without IndexedDB; the browser uses `BROWSER_PLAN_STORE`.
 */

import { el, append, clear } from './dom.js';
import {
  emptyPlan, loadPlan, onPlanSaved, savePlan, savePlanIfUnchanged,
                                              
} from '../multicloud/plan/store.js';
                                                        

/** What the session needs of the plan store. */
                               
                               
                                                                                
                                  
                                           
                                                                     
 

export const BROWSER_PLAN_STORE               = {
  load: loadPlan,
  saveIfUnchanged: savePlanIfUnchanged,
  saveAnyway: savePlan,
  onSaved: onPlanSaved,
};

/** Why the banner is up. */
                                                            
                                
                                  
 

                                                     

/**
 * What to do when another page announces a save. A message for the version
 * this page already has is an echo (ignore); otherwise reload when nothing
 * here is unsaved, and ask when something is.
 */
export function onOtherSave(state                                                              , message                  )             {
  if (state.basedOn !== null && message.savedAt === state.basedOn) return 'ignore';
  return state.dirty ? 'ask' : 'reload';
}

                                                                 

                              
               
                                   
                   
                                                                          
                    
                                   
                                                                                  
                                                                                         
                                                                   
                                                
                                
                                   
                                                       
                          
                                                    
                               
                                                                          
                                                                             
                  
 

                                 
                               
                              
 

export async function openPlanSession(api               = BROWSER_PLAN_STORE, options                 = {})                       {
  const debounceMs = options.debounceMs ?? 700;
  const now = options.now ?? (() => new Date().toISOString());

  const loaded = await api.load().catch(() => null);
  let plan       = loaded ?? emptyPlan();
  /** The stored `savedAt` this copy is based on; null when nothing is stored. */
  let basedOn                = loaded ? loaded.savedAt : null;
  let dirty = false;
  let edits = 0;
  let conflict                       = null;
  let timer                                           ;
  let saving                                  = null;

  const listeners = new Set                                        ();
  const conflictListeners = new Set                                   ();
  const emit = (kind            ) => {
    for (const l of [...listeners]) {
      try {
        l(plan, kind);
      } catch {
        // One pane failing to re-render does not stop the others.
      }
    }
  };
  const setConflict = (c                      ) => {
    conflict = c;
    for (const l of [...conflictListeners]) l(c);
  };
  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  async function doSave()                           {
    cancelTimer();
    if (conflict) return 'conflict';
    const startEdits = edits;
    const next       = { ...plan, savedAt: now() };
    const outcome = await api.saveIfUnchanged(next, basedOn ?? '').catch(()                  => 'failed');
    if (outcome === 'saved') {
      basedOn = next.savedAt;
      // Edits made while the save was in flight stay pending.
      plan = edits === startEdits ? next : { ...plan, savedAt: next.savedAt };
      dirty = edits !== startEdits;
      if (dirty) schedule();
      emit('saved');
    } else if (outcome === 'conflict') {
      setConflict({ reason: 'save-conflict' });
    }
    return outcome;
  }

  function save()                           {
    if (saving) return saving.then(() => (dirty ? save() : 'saved'));
    saving = doSave().finally(() => {
      saving = null;
    });
    return saving;
  }

  function schedule()       {
    cancelTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void save();
    }, debounceMs);
  }

  async function reload()                {
    cancelTimer();
    const fresh = await api.load().catch(() => null);
    plan = fresh ?? emptyPlan();
    basedOn = fresh ? fresh.savedAt : null;
    dirty = false;
    edits += 1;
    setConflict(null);
    emit('reload');
  }

  const unsubscribe = api.onSaved((message) => {
    const action = onOtherSave({ basedOn, dirty }, message);
    if (action === 'reload') void reload();
    else if (action === 'ask') setConflict({ reason: 'other-page' });
  });

  return {
    plan: () => plan,
    dirty: () => dirty,
    stored: () => basedOn !== null,
    conflict: () => conflict,
    update(change, opts) {
      plan = change(plan);
      dirty = true;
      edits += 1;
      emit('edit');
      if (opts?.immediate) void save();
      else schedule();
    },
    async replace(next) {
      plan = next;
      dirty = true;
      edits += 1;
      emit('replace');
      return save();
    },
    save,
    reload,
    async keepMine() {
      cancelTimer();
      const next       = { ...plan, savedAt: now() };
      const ok = await api.saveAnyway(next).catch(() => false);
      if (ok) {
        plan = next;
        basedOn = next.savedAt;
        dirty = false;
        setConflict(null);
        emit('saved');
      }
      return ok;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConflict(listener) {
      conflictListeners.add(listener);
      return () => conflictListeners.delete(listener);
    },
    dispose() {
      cancelTimer();
      unsubscribe();
      listeners.clear();
      conflictListeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

export const CONFLICT_MESSAGE = 'The plan was changed on the other page.';
export const CONFLICT_RELOAD = 'Reload';
export const CONFLICT_RELOAD_NOTE = '(your unsaved change is lost)';
export const CONFLICT_KEEP = 'Keep mine';
export const CONFLICT_KEEP_NOTE = '(overwrites)';

/**
 * The conflict banner, mounted into `slot`: empty while there is no conflict,
 * and the message with its two buttons while there is one.
 */
export function mountConflictBanner(slot             , session             )             {
  const render = (c                      ) => {
    clear(slot);
    if (!c) return;
    const reload = el('button', { class: 'btn btn-primary', text: CONFLICT_RELOAD, attrs: { type: 'button', 'data-control': 'plan-reload' } });
    const keep = el('button', { class: 'btn', text: CONFLICT_KEEP, attrs: { type: 'button', 'data-control': 'plan-keep-mine' } });
    reload.addEventListener('click', () => void session.reload());
    keep.addEventListener('click', () => void session.keepMine());
    append(
      slot,
      el(
        'div',
        { class: 'tip warn', attrs: { role: 'alert', 'data-control': 'plan-conflict' } },
        el('strong', { text: `${CONFLICT_MESSAGE} ` }),
        el('span', { text: `${CONFLICT_RELOAD} ${CONFLICT_RELOAD_NOTE} or ${CONFLICT_KEEP} ${CONFLICT_KEEP_NOTE}.` }),
        el('div', { class: 'btn-row', style: { marginTop: 'var(--space-2)' } }, reload, keep),
      ),
    );
  };
  render(session.conflict());
  return session.onConflict(render);
}

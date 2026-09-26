/**
 * STUB — Servers (`#servers`) on Application Migration (`migration.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-A
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.js';
                                                    

export function mount(root             , ctx             )       {
  stubPane(root, ctx, {
    title: "Servers",
    does: "Every server from every source in one grid, with the Source, Type and Basis columns (and IP strategy, Rename and Upgrade), CSV import and export, and bulk edits.",
    owner: "WP-UI-A",
  });
}

/**
 * STUB — Databases (`#databases`) on Application Migration (`migration.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-A
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.js';
                                                    

export function mount(root             , ctx             )       {
  stubPane(root, ctx, {
    title: "Databases",
    does: "Every database, its engine, edition, size and host, including the engines beyond the core, as a grid with CSV import and export.",
    owner: "WP-UI-A",
  });
}

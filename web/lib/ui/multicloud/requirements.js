/**
 * STUB — Constraints (`#constraints`) on Application Migration (`migration.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-A
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.js';
                                                    

export function mount(root             , ctx             )       {
  stubPane(root, ctx, {
    title: "Constraints",
    does: "The constraint cards: Platforms, Compliance & sovereignty, Commercial & licensing, Operating model & exit, and Resilience. Connectivity and Identity are estate foundations and live on Landing zones.",
    owner: "WP-UI-A",
  });
}

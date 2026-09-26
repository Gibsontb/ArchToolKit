/**
 * STUB — Applications (`#applications`) on Application Migration (`migration.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-D
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.js';
                                                    

export function mount(root             , ctx             )       {
  stubPane(root, ctx, {
    title: "Applications",
    does: "The application catalogue, with each app's servers, databases, pattern, chosen cloud and status, the Dependency map view, and New application for a greenfield service.",
    owner: "WP-UI-D",
  });
}

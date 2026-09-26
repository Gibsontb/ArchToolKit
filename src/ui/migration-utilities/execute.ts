/**
 * STUB — Execute (`#execute`) on Multi-Cloud Migration & Utilities (`multicloud.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-C
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Execute",
    does: "The execution settings per path (#execute:settings) and the wave console (#execute:<wave>/<stage>) with the stages replicate, test, cutover, validate and decommission.",
    owner: "WP-UI-C",
  });
}

/**
 * STUB — Generate (`#generate`) on Multi-Cloud Migration & Utilities (`multicloud.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-B
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Generate",
    does: "The migration project: landing zones, the execution kit, waves, runbooks and governance, as one reproducible zip.",
    owner: "WP-UI-B",
  });
}

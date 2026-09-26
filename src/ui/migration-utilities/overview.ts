/**
 * STUB — Overview (`#overview`) on Multi-Cloud Migration & Utilities (`multicloud.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-C (with WP-UI-B's estate check)
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Overview",
    does: "The saved application plans, their platforms and statuses, and the estate placement check (the decision tables, read-only; overrides are made per app on Application Migration).",
    owner: "WP-UI-C (with WP-UI-B's estate check)",
  });
}

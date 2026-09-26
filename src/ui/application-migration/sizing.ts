/**
 * STUB — Sizing (`#sizing`) on Application Migration (`migration.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-D
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Sizing",
    does: "The sizing policy (percentile, headroom, families, disk basis) and every app's sizing in one grid, with bulk accept and override, and a data-confidence warning below 80%.",
    owner: "WP-UI-D",
  });
}

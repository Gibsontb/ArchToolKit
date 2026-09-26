/**
 * STUB — Application (`#app:<app-slug>[/<tab>]`) on Application Migration (`migration.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-D
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Application",
    does: "One application's workspace: Overview, Components, Configuration, Dependencies, Coupling, Assessment, Target, Sizing, Compare and Generate. The target architecture sits on the one cloud chosen for it, recommended by the engine and switchable.",
    owner: "WP-UI-D",
  });
}

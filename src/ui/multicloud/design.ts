/**
 * STUB — Landing zones (`#landing-zones`) on Multi-Cloud Migration & Utilities (`multicloud.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-B
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Landing zones",
    does: "One card per platform in use: networks, connectivity (the sites grid), identity, backup and DR, monitoring, governance (policies, budgets, tag defaults) and the relocate target with the VCF Sizing handoff. Generates the landing-zone projects.",
    owner: "WP-UI-B",
  });
}

/**
 * STUB — Governance (`#waves:governance`) on Multi-Cloud Migration & Utilities (`multicloud.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-C
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Governance",
    does: "RACI, communications, change requests, the CMDB and asset register, and the sign-off matrix.",
    owner: "WP-UI-C",
  });
}

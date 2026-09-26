/**
 * STUB — Utilities (`#utilities`) on Multi-Cloud Migration & Utilities (`multicloud.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-C
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Utilities",
    does: "Day-2 utilities without a migration: add or resize a server, add or extend a disk, open a port, add a DNS record, a patch run and more, each a small Terraform and Ansible bundle, plus Deploy a new service and the utility log. A utility's form is #utilities:<utility-id>.",
    owner: "WP-UI-C",
  });
}

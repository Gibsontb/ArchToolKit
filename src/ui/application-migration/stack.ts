/**
 * STUB — Stack & generate (`#stack`) on Application Migration (`migration.html`).
 *
 * Mounted by the page shell (WP-14) through `mount(root, ctx)`; WP-UI-D
 * replaces this body with the real pane and keeps the export.
 */

import { stubPane } from '../pane-stub.ts';
import type { PaneContext } from '../plan-shell.ts';

export function mount(root: HTMLElement, ctx: PaneContext): void {
  stubPane(root, ctx, {
    title: "Stack & generate",
    does: "Select applications and generate one stacked Terraform and Ansible project, with environments and CI/CD.",
    owner: "WP-UI-D",
  });
}

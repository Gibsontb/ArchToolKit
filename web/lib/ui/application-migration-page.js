/**
 * Application Migration (`migration.html`): every application, from any
 * source, with its servers, databases and dependencies, and a target
 * architecture on the one cloud chosen for it (addendum A.1.2).
 *
 * This is the shell only: the header (plan mode, the plan's file bar, the link
 * to Multi-Cloud Migration & Utilities), the conflict banner, and the panes,
 * each a module loaded on first open. The step bar reads Sources · Servers ·
 * Databases · Applications · Constraints · Stack; Sizing and the application
 * workspace (`#app:<slug>[/<tab>]`) are panes without a step number.
 *
 * With no hash the page opens on Applications when the plan has apps, else on
 * Sources (in `single` mode, on the one app's workspace). The retired rating
 * page's anchors (`#intake`, `#ratings`, `#results`, `#portfolio`, `#help`)
 * open Applications; the old portfolio is imported from Sources.
 */

import { mountPlanPage,               } from './plan-shell.js';

export const APPLICATION_MIGRATION_SPECS                      = [
  { id: 'sources', load: () => import('./multicloud/sources.js') },
  { id: 'servers', load: () => import('./multicloud/workloads.js') },
  { id: 'databases', load: () => import('./multicloud/databases.js') },
  { id: 'applications', load: () => import('./application-migration/applications.js') },
  { id: 'app', load: () => import('./application-migration/workspace.js') },
  { id: 'constraints', load: () => import('./multicloud/requirements.js') },
  { id: 'sizing', load: () => import('./application-migration/sizing.js') },
  { id: 'stack', load: () => import('./application-migration/stack.js') },
];

const root = typeof document !== 'undefined' ? document.getElementById('migration-root') : null;
const header = typeof document !== 'undefined' ? document.getElementById('plan-header') : null;
if (root && header) {
  void mountPlanPage({
    page: 'application-migration',
    root,
    header,
    panes: APPLICATION_MIGRATION_SPECS,
    otherPage: { href: 'multicloud.html', label: 'Open Migration & Utilities' },
  });
}

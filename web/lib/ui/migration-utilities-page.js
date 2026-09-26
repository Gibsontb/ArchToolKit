/**
 * Multi-Cloud Migration & Utilities (`multicloud.html`): takes the saved
 * application plans and the estate and runs the move, then keeps changing it
 * (addendum A.1.3, with the lead's naming: the day-2 area is Utilities).
 *
 * The step bar has two areas. Migrate: Overview, Landing zones, Estate
 * capacity, Data centre (data-centre exit only), Waves (with
 * `#waves:governance`), Execute (`#execute:settings`,
 * `#execute:<wave>/<stage>`), the Track panes (Board, Timeline, RAID,
 * Reports) and Generate. Utilities: `#utilities` and `#utilities:<utility-id>`.
 *
 * With no hash the page opens on the Board when the tracker has any item past
 * `planned`, else on Overview. The retired planner's intake and decision
 * anchors (`#sources`, `#workloads`, `#databases`, `#apps`, `#requirements`,
 * `#decision`, `#design`) now live on Application Migration and are sent
 * there with `location.replace`; `#waves` and `#generate` stay here. The
 * addendum's `#changes` opens Utilities.
 *
 * The tracker is read through the store's raw record (key `tracker`), which
 * is light; the Track panes bring the tracker engine when they open.
 */

import { mountPlanPage,               } from './plan-shell.js';
import { loadTrackerRecord } from '../multicloud/plan/store.js';

export const MIGRATION_UTILITIES_SPECS                      = [
  { id: 'overview', load: () => import('./migration-utilities/overview.js') },
  { id: 'landing-zones', load: () => import('./multicloud/design.js') },
  { id: 'capacity', load: () => import('./migration-utilities/capacity.js') },
  { id: 'datacentre', load: () => import('./migration-utilities/datacentre.js') },
  {
    id: 'waves',
    load: () => import('./multicloud/waves.js'),
    sub: { governance: () => import('./migration-utilities/governance.js') },
  },
  { id: 'execute', load: () => import('./migration-utilities/execute.js') },
  { id: 'board', load: () => import('./migration-utilities/board.js') },
  { id: 'timeline', load: () => import('./migration-utilities/timeline.js') },
  { id: 'raid', load: () => import('./migration-utilities/raid.js') },
  { id: 'reports', load: () => import('./migration-utilities/reports.js') },
  { id: 'generate', load: () => import('./multicloud/generate.js') },
  { id: 'utilities', load: () => import('./migration-utilities/utilities.js') },
];

const root = typeof document !== 'undefined' ? document.getElementById('multicloud-root') : null;
const header = typeof document !== 'undefined' ? document.getElementById('plan-header') : null;
if (root && header) {
  void mountPlanPage({
    page: 'migration-utilities',
    root,
    header,
    panes: MIGRATION_UTILITIES_SPECS,
    otherPage: { href: 'migration.html', label: 'Open Application Migration' },
    tracker: () => loadTrackerRecord(),
  });
}

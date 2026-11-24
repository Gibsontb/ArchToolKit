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

import { mountPlanPage, type PaneSpec } from './plan-shell.ts';
import { loadTrackerRecord } from '../multicloud/plan/store.ts';

export const MIGRATION_UTILITIES_SPECS: readonly PaneSpec[] = [
  { id: 'vmware-exit', load: () => import('./migration-utilities/vmware-exit.ts') },
  { id: 'source-inventory', load: () => import('./multicloud/sources.ts') },
  { id: 'landing-zones', load: () => import('./multicloud/design.ts') },
  { id: 'capacity', load: () => import('./migration-utilities/capacity.ts') },
  { id: 'datacentre', load: () => import('./migration-utilities/datacentre.ts') },
  {
    id: 'waves',
    load: () => import('./multicloud/waves.ts'),
    sub: { governance: () => import('./migration-utilities/governance.ts') },
  },
  { id: 'execute', load: () => import('./migration-utilities/execute.ts') },
  { id: 'board', load: () => import('./migration-utilities/board.ts') },
  { id: 'timeline', load: () => import('./migration-utilities/timeline.ts') },
  { id: 'raid', load: () => import('./migration-utilities/raid.ts') },
  { id: 'reports', load: () => import('./migration-utilities/reports.ts') },
  { id: 'generate', load: () => import('./multicloud/generate.ts') },
  { id: 'overview', load: () => import('./migration-utilities/overview.ts') },
  { id: 'utilities', load: () => import('./migration-utilities/utilities.ts') },
];

const root = typeof document !== 'undefined' ? document.getElementById('multicloud-root') : null;
const header = typeof document !== 'undefined' ? document.getElementById('plan-header') : null;
const route=typeof location!=='undefined'?location.hash.slice(1):'';
const landingRequest=route.startsWith('landing-zones') || (route.startsWith('vmware-exit:')&&new URLSearchParams(route.split(':').slice(1).join(':')).get('mode')==='landing-zone');
const serviceRequest=route.startsWith('vmware-exit:')&&new URLSearchParams(route.split(':').slice(1).join(':')).get('mode')==='new';
if(root&&header&&serviceRequest){
  globalThis.location.replace('add-service.html?'+new URLSearchParams(route.split(':').slice(1).join(':')));
}else if(root&&header&&landingRequest){
  const query=route.startsWith('landing-zones')?new URLSearchParams({provider:route.split(':')[1]??''}):new URLSearchParams(route.split(':').slice(1).join(':'));
  globalThis.location.replace('landing-zone.html?'+query);
}else if (root && header && !globalThis.location.hash) {
  globalThis.location.replace('../cloud-decision-logic-kit/multi-cloud-decision-matrix.html');
} else if (root && header) {
  void mountPlanPage({
    page: 'migration-utilities',
    root,
    header,
    panes: MIGRATION_UTILITIES_SPECS,
    otherPage: { href: 'migration.html', label: 'Open Application Migration' },
    tracker: () => loadTrackerRecord(),
  });
}

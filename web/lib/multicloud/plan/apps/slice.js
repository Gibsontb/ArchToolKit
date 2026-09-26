/**
 * The app slice (addendum A.2.5): a Plan holding only the selected apps.
 *
 * It keeps their workloads and databases, the edges among them, their app
 * plans and the full requirements (and every setting: overrides, waves,
 * sizing, generation, execution, governance), under the plan's own id, name
 * and date. So every generator takes a slice, and "one app" and "a stack of
 * apps" are the same code with a different selection — and an app's rows come
 * out the same whichever selection it is in.
 */

import { slugName } from '../options.js';
                                             
import { appDatabases, appWorkloads, findApp } from './components.js';

/** The apps a selection names (ids or names), in plan order; unknown references are ignored. */
export function selectedApps(plan                    , appIds                   )        {
  const ids = new Set(appIds.map((r) => findApp(plan, r)?.id).filter((x)              => !!x));
  return plan.apps.filter((a) => ids.has(a.id));
}

/** A Plan with only these apps (ids or names). The cached decision is dropped. */
export function appSlice(plan      , appIds                   )       {
  const apps = selectedApps(plan, appIds);
  const names = new Set(apps.map((a) => a.name));
  const workloads = apps.flatMap((a) => appWorkloads(plan, a));
  const wNames = new Set(workloads.map((w) => w.name));
  const dbIds = new Set(apps.flatMap((a) => appDatabases(plan, a).map((d) => d.id)));
  const databases = plan.databases.filter((d) => dbIds.has(d.id));
  const dNames = new Set(databases.map((d) => d.name));
  const inSlice = (end        )          => names.has(end) || wNames.has(end) || dNames.has(end);
  const edges = plan.edges.filter((e) => inSlice(e.from) && inSlice(e.to));
  const appIdSet = new Set(apps.map((a) => a.id));
  const { decision: _cached, ...rest } = plan;
  return {
    ...rest,
    workloads,
    databases,
    apps,
    edges,
    appPlans: (plan.appPlans ?? []).filter((p) => appIdSet.has(p.app)),
  };
}

/** The folder a generated app project goes in: `<slug(app)>/` for one app, `<slug(plan)>-apps/` for a stack. */
export function sliceFolder(plan                             , appIds                   )         {
  const apps = selectedApps(plan, appIds);
  if (apps.length === 1) return slugName(apps[0] .name) || 'app';
  return `${slugName(plan.name) || 'plan'}-apps`;
}

/**
 * The "From an application plan" Terraform blueprints (addendum A.4.10,
 * A.10.14, A.10.15), one file per family, each with its blueprints for every
 * platform that has the service. `PATTERN_TERRAFORM_BLUEPRINTS` is every one;
 * `patternBlueprintsFor(target)` is a platform's, for its group's
 * `combine(...)` in `../index.ts`.
 */

import { derive, str as valueOf, type Blueprint, type BlueprintValues } from '../../../kit/blueprint.ts';
import { topLevelBlocks } from '../../stack.ts';
import { ident } from '../migration/common.ts';
import { APP_CONTEXT_BLUEPRINTS } from './app-context.ts';
import { APPLIANCE_BLUEPRINTS } from './appliance.ts';
import { CONTAINER_BLUEPRINTS } from './containers.ts';
import { DATA_SERVICE_BLUEPRINTS } from './data-services.ts';
import { FILE_BLUEPRINTS } from './file.ts';
import { GOVERNANCE_BLUEPRINTS } from './governance.ts';
import { INGRESS_BLUEPRINTS } from './ingress.ts';
import { MESSAGING_BLUEPRINTS } from './messaging.ts';
import { MONITORING_BLUEPRINTS } from './monitoring.ts';
import { PAAS_BLUEPRINTS } from './paas.ts';
import { SAP_BLUEPRINTS } from './sap.ts';
import { SERVERLESS_BLUEPRINTS } from './serverless.ts';
import { STATIC_SITE_BLUEPRINTS } from './static-site.ts';
import { VDI_BLUEPRINTS } from './vdi.ts';

export { PATTERN_GROUP } from './common.ts';

/**
 * The local-name prefix of an app item's resources: the app, and the
 * component when there is one (`shop_web_`). Two apps (or two components of
 * one pattern) in one stack never share an address, so an app's file is the
 * same byte for byte whether it is stacked alone or with others, and the
 * stack builder never has to rename it (which would depend on the order).
 */
export function appScope(values: BlueprintValues): string {
  const app = ident(valueOf(values, 'app', 'app')) || 'app';
  const component = valueOf(values, 'component').trim();
  const last = component.split(':').pop() ?? '';
  return last ? `${app}_${ident(last)}` : app;
}

const escape = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rename every resource, data source and module an item declares to `<scope>_<name>`, declarations and references together. */
export function scopeAddresses(hcl: string, scope: string): string {
  let out = hcl;
  for (const b of topLevelBlocks(hcl)) {
    if (b.kind !== 'resource' && b.kind !== 'data' && b.kind !== 'module') continue;
    const type = b.labels[0] ?? '';
    const from = (b.kind === 'module' ? b.labels[0] : b.labels[1]) ?? '';
    if (!from || from.startsWith(`${scope}_`)) continue;
    const to = `${scope}_${from}`;
    const f = escape(from);
    if (b.kind === 'module') {
      out = out.replace(new RegExp(String.raw`module\s+"${f}"`, 'g'), `module "${to}"`);
      out = out.replace(new RegExp(String.raw`\bmodule\.${f}\b(?!-)`, 'g'), `module.${to}`);
      continue;
    }
    const t = escape(type);
    const head = b.kind === 'data' ? 'data' : 'resource';
    out = out.replace(new RegExp(String.raw`${head}\s+"${t}"\s+"${f}"`, 'g'), `${head} "${type}" "${to}"`);
    const ref = b.kind === 'data' ? String.raw`\bdata\.${t}\.${f}\b(?!-)` : String.raw`(?<![.\w])${t}\.${f}\b(?!-)`;
    out = out.replace(new RegExp(ref, 'g'), `${b.kind === 'data' ? `data.${type}` : type}.${to}`);
  }
  return out;
}

/** An app item whose addresses are scoped to its app (and component). */
function scoped(bp: Blueprint): Blueprint {
  if (!bp.inputs.some((i) => i.id === 'app')) return bp;
  return derive(bp, {
    build: (values, name) => {
      const built = bp.build(values, name);
      const scope = appScope(values);
      const files = Object.fromEntries(Object.entries(built.files).map(([f, t]) => [f, /\.tf$/i.test(f) ? scopeAddresses(t, scope) : t]));
      return { ...built, files };
    },
  });
}

export const PATTERN_TERRAFORM_BLUEPRINTS: readonly Blueprint[] = [
  ...APP_CONTEXT_BLUEPRINTS,
  ...INGRESS_BLUEPRINTS,
  ...PAAS_BLUEPRINTS,
  ...SERVERLESS_BLUEPRINTS,
  ...STATIC_SITE_BLUEPRINTS,
  ...CONTAINER_BLUEPRINTS,
  ...FILE_BLUEPRINTS,
  ...VDI_BLUEPRINTS,
  ...SAP_BLUEPRINTS,
  ...MESSAGING_BLUEPRINTS,
  ...DATA_SERVICE_BLUEPRINTS,
  ...APPLIANCE_BLUEPRINTS,
  ...MONITORING_BLUEPRINTS,
  ...GOVERNANCE_BLUEPRINTS,
].map(scoped);

/** The blueprints of one platform's group: `aws`, `azure`, `google`, `oci` or `vsphere`. */
export function patternBlueprintsFor(target: 'aws' | 'azure' | 'google' | 'oci' | 'vsphere'): readonly Blueprint[] {
  return PATTERN_TERRAFORM_BLUEPRINTS.filter((b) => b.id.startsWith(`${target}_`));
}

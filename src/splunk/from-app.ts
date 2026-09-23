/**
 * A Splunk app, as the files someone can deploy.
 *
 * The conf files, an `app.conf` so it is a real app, a `metadata/default.meta`
 * so the objects in it are visible to anyone, and a deployment note saying
 * which tier it goes on and how it is activated.
 *
 * All of it from one structure, so the note cannot describe a different app
 * from the one in the directory.
 */

import type { Blueprint, BlueprintValues, BuildResult } from '../kit/blueprint.ts';
import type { Finding } from '../core/findings.ts';
import { appConf, renderApp, renderRecord, standingFindings, type SplunkApp, type SplunkTier } from './splunk.ts';

export interface SplunkBlueprint extends Blueprint {
  /** The tier this app is deployed to, so a bundle can group by it. */
  readonly tier: SplunkTier;
  /** The structured app, for the deployment note to read. */
  readonly app: (values: BlueprintValues, name: string) => SplunkApp;
}

export function appFiles(app: SplunkApp, name: string): BuildResult {
  // An app without an app.conf is a directory Splunk may or may not read, so
  // one is added here — before the checks run, so they see the app as shipped.
  const complete: SplunkApp = Object.keys(app.files).includes('default/app.conf')
    ? app
    : { ...app, files: { ...app.files, 'default/app.conf': appConf(app, app.title) } };
  const findings: Finding[] = [...(complete.findings ?? []), ...standingFindings(complete)];
  const files: Record<string, string> = renderApp(complete, name);

  files['DEPLOY.md'] = `${[`# ${complete.title}`, '', ...renderRecord(complete, name)].join('\n')}\n`;

  return { files, findings };
}

/**
 * Declare a blueprint from an app builder.
 *
 * The page sees an ordinary `Blueprint`; anything that needs the structure —
 * the deployment note, the tier grouping — sees the app underneath it.
 */
export function splunkBlueprint(
  spec: Omit<Blueprint, 'build' | 'emits'> & {
    readonly tier: SplunkTier;
    readonly emits?: readonly string[];
    readonly app: (values: BlueprintValues, name: string) => SplunkApp;
  },
): SplunkBlueprint {
  return {
    ...spec,
    emits: spec.emits ?? [],
    build: (values: BlueprintValues, name: string) => appFiles(spec.app(values, name), name),
  };
}

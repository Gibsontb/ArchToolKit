/**
 * The Splunk app generator.
 *
 * The platform picker here is the **tier** — search head, indexer, forwarder —
 * because that is the question that decides whether a setting does anything at
 * all. A `props.conf` deployed to a search head does not parse data arriving
 * from a forwarder: the app deploys, the file is read, and nothing happens,
 * with no error anywhere. Choosing the tier first makes that a decision rather
 * than a discovery three weeks later.
 *
 * It is not a cloud, so the choice stays on this page rather than being written
 * into the toolkit-wide target.
 */

import { mountGeneratorPage } from './generator-page.ts';
import { SPLUNK_BLUEPRINTS } from '../splunk/blueprints/index.ts';
import { info, type Finding } from '../core/findings.ts';

const root = document.getElementById('splunk-root');
if (root) {
  mountGeneratorPage(root, {
    groups: SPLUNK_BLUEPRINTS,
    kindLabel: 'Splunk app',
    noun: 'app',
    idleHint:
      'Pick the tier the app will be deployed to, then what it does. The generated app includes its conf files, an app.conf, the metadata that makes its objects visible, and a deployment note saying where it goes and how it is activated.',
    settingsKind: 'archtoolkit.splunk-generator',
    // A Splunk tier is not a cloud.
    sharedPlatform: false,
    downloadExtension: '.conf',
    // Splunk's "Install app from file" and the deployment server take the app
    // folder as a gzipped tar; .spl is the same format with Splunk's name.
    packages: [{ label: 'Download app as .spl', extension: '.spl', include: (path: string) => path.includes('/') }],
    standingFindings: (): Finding[] => [
      info('splunk.tier-decides-everything', 'The tier is not a label. A setting on the wrong tier does nothing, reports nothing, and looks exactly like a setting that worked — which is why this page asks for it first.', {
        source: 'ArchToolKit',
      }),
    ],
  });
}

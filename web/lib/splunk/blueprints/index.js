/**
 * Every Splunk app, grouped by the tier it is deployed to.
 *
 * The tier is the organising question because it is the one that decides
 * whether a setting does anything at all. A `props.conf` on a search head does
 * not parse data arriving from a forwarder, and the failure is silent — the app
 * deploys, the file is read, and nothing happens. Choosing the tier first makes
 * that a decision rather than a discovery.
 */

                                                             
                                                      
import { TIERS } from '../splunk.js';
import { SEARCH_HEAD_BLUEPRINTS } from './search-head.js';
import { INDEXER_BLUEPRINTS } from './indexer.js';
import { FORWARDER_BLUEPRINTS } from './forwarder.js';
import { FORWARDER_MORE_BLUEPRINTS } from './forwarder-more.js';
import { INDEXER_MORE_BLUEPRINTS } from './indexer-more.js';
import { EDGE_BLUEPRINTS } from './edge.js';
import { MANAGEMENT_PLATFORM_BLUEPRINTS } from './management-platform.js';
import { MANAGEMENT_SECURITY_BLUEPRINTS } from './management-security.js';
import { HEAVY_FORWARDER_BLUEPRINTS } from './heavy-forwarder.js';
import { CLOUD_BLUEPRINTS } from './cloud.js';
import { CLOUD_ACS_BLUEPRINTS } from './cloud-acs.js';
import { ADDON_BLUEPRINTS } from './addon.js';
import { ONBOARDING_MORE_BLUEPRINTS } from './onboarding-more.js';
import { SEARCH_HEAD_MORE_BLUEPRINTS } from './search-head-more.js';
import { SEARCH_HEAD_KNOWLEDGE_BLUEPRINTS } from './search-head-knowledge.js';
import { INDEXER_STORAGE_BLUEPRINTS } from './indexer-storage.js';
import { MANAGEMENT_10X_BLUEPRINTS } from './management-10x.js';
import { FORWARDER_10X_BLUEPRINTS } from './forwarder-10x.js';
import { withSplunkChoices } from '../choices.js';

/** Indexes, sourcetypes, time ranges and the like as dropdowns, the same in every blueprint. */
const withChoices = (list                            )                    => list.map((b) => ({ ...b, inputs: b.inputs.map((i) => withSplunkChoices(i, b.id)) }));

const SEARCH_HEAD = withChoices([...SEARCH_HEAD_BLUEPRINTS, ...SEARCH_HEAD_MORE_BLUEPRINTS, ...SEARCH_HEAD_KNOWLEDGE_BLUEPRINTS]);
const INDEXER = withChoices([...INDEXER_BLUEPRINTS, ...INDEXER_MORE_BLUEPRINTS, ...INDEXER_STORAGE_BLUEPRINTS]);
// The 10.x forwarder set holds a heavy-forwarder blueprint too (a modular input needs Python): each goes to its own tier.
const FORWARDER = withChoices([...FORWARDER_BLUEPRINTS, ...FORWARDER_MORE_BLUEPRINTS, ...FORWARDER_10X_BLUEPRINTS.filter((b) => b.tier === 'forwarder')]);
const MANAGEMENT = withChoices([...MANAGEMENT_PLATFORM_BLUEPRINTS, ...MANAGEMENT_SECURITY_BLUEPRINTS, ...MANAGEMENT_10X_BLUEPRINTS]);
const HEAVY_FORWARDER = withChoices([...HEAVY_FORWARDER_BLUEPRINTS, ...FORWARDER_10X_BLUEPRINTS.filter((b) => b.tier === 'heavy_forwarder')]);
const ADDON = withChoices([...ADDON_BLUEPRINTS, ...ONBOARDING_MORE_BLUEPRINTS]);
const CLOUD = withChoices([...CLOUD_BLUEPRINTS, ...CLOUD_ACS_BLUEPRINTS]);
const EDGE = withChoices(EDGE_BLUEPRINTS);

export const SEARCH_HEAD_APPS                 = { target: 'search_head', label: TIERS.search_head.label, blueprints: SEARCH_HEAD };
export const INDEXER_APPS                 = { target: 'indexer', label: TIERS.indexer.label, blueprints: INDEXER };
export const FORWARDER_APPS                 = { target: 'forwarder', label: TIERS.forwarder.label, blueprints: FORWARDER };
export const MANAGEMENT_APPS                 = { target: 'management', label: 'Management and platform', blueprints: MANAGEMENT };
export const HEAVY_FORWARDER_APPS                 = { target: 'heavy_forwarder', label: TIERS.heavy_forwarder.label, blueprints: HEAVY_FORWARDER };
export const ADDON_APPS                 = { target: 'addon', label: 'Add-ons and onboarding', blueprints: ADDON };
export const CLOUD_APPS                 = { target: 'cloud', label: TIERS.cloud.label, blueprints: CLOUD };
export const EDGE_APPS                 = { target: 'edge', label: TIERS.edge.label, blueprints: EDGE };

export const SPLUNK_BLUEPRINTS                            = [ADDON_APPS, MANAGEMENT_APPS, SEARCH_HEAD_APPS, INDEXER_APPS, HEAVY_FORWARDER_APPS, FORWARDER_APPS, EDGE_APPS, CLOUD_APPS];

/** Every Splunk blueprint, with its structured builder, in one list. */
export const SPLUNK_APPS                             = [...ADDON, ...MANAGEMENT, ...SEARCH_HEAD, ...INDEXER, ...HEAVY_FORWARDER, ...FORWARDER, ...EDGE, ...CLOUD];

export function splunkApp(id        )                              {
  return SPLUNK_APPS.find((blueprint) => blueprint.id === id);
}

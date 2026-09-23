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
import { ADDON_BLUEPRINTS } from './addon.js';
import { SEARCH_HEAD_MORE_BLUEPRINTS } from './search-head-more.js';

const SEARCH_HEAD = [...SEARCH_HEAD_BLUEPRINTS, ...SEARCH_HEAD_MORE_BLUEPRINTS];
const INDEXER = [...INDEXER_BLUEPRINTS, ...INDEXER_MORE_BLUEPRINTS];
const FORWARDER = [...FORWARDER_BLUEPRINTS, ...FORWARDER_MORE_BLUEPRINTS];
const MANAGEMENT = [...MANAGEMENT_PLATFORM_BLUEPRINTS, ...MANAGEMENT_SECURITY_BLUEPRINTS];

export const SEARCH_HEAD_APPS                 = { target: 'search_head', label: TIERS.search_head.label, blueprints: SEARCH_HEAD };
export const INDEXER_APPS                 = { target: 'indexer', label: TIERS.indexer.label, blueprints: INDEXER };
export const FORWARDER_APPS                 = { target: 'forwarder', label: TIERS.forwarder.label, blueprints: FORWARDER };
export const MANAGEMENT_APPS                 = { target: 'management', label: 'Management and platform', blueprints: MANAGEMENT };
export const HEAVY_FORWARDER_APPS                 = { target: 'heavy_forwarder', label: TIERS.heavy_forwarder.label, blueprints: HEAVY_FORWARDER_BLUEPRINTS };
export const ADDON_APPS                 = { target: 'addon', label: 'Add-ons and onboarding', blueprints: ADDON_BLUEPRINTS };
export const CLOUD_APPS                 = { target: 'cloud', label: TIERS.cloud.label, blueprints: CLOUD_BLUEPRINTS };
export const EDGE_APPS                 = { target: 'edge', label: TIERS.edge.label, blueprints: EDGE_BLUEPRINTS };

export const SPLUNK_BLUEPRINTS                            = [ADDON_APPS, MANAGEMENT_APPS, SEARCH_HEAD_APPS, INDEXER_APPS, HEAVY_FORWARDER_APPS, FORWARDER_APPS, EDGE_APPS, CLOUD_APPS];

/** Every Splunk blueprint, with its structured builder, in one list. */
export const SPLUNK_APPS                             = [...ADDON_BLUEPRINTS, ...MANAGEMENT, ...SEARCH_HEAD, ...INDEXER, ...HEAVY_FORWARDER_BLUEPRINTS, ...FORWARDER, ...EDGE_BLUEPRINTS, ...CLOUD_BLUEPRINTS];

export function splunkApp(id        )                              {
  return SPLUNK_APPS.find((blueprint) => blueprint.id === id);
}

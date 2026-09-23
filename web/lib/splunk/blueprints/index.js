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

export const SEARCH_HEAD_APPS                 = { target: 'search_head', label: TIERS.search_head.label, blueprints: SEARCH_HEAD_BLUEPRINTS };
export const INDEXER_APPS                 = { target: 'indexer', label: TIERS.indexer.label, blueprints: INDEXER_BLUEPRINTS };
export const FORWARDER_APPS                 = { target: 'forwarder', label: TIERS.forwarder.label, blueprints: FORWARDER_BLUEPRINTS };

export const SPLUNK_BLUEPRINTS                            = [SEARCH_HEAD_APPS, INDEXER_APPS, FORWARDER_APPS];

/** Every Splunk blueprint, with its structured builder, in one list. */
export const SPLUNK_APPS                             = [...SEARCH_HEAD_BLUEPRINTS, ...INDEXER_BLUEPRINTS, ...FORWARDER_BLUEPRINTS];

export function splunkApp(id        )                              {
  return SPLUNK_APPS.find((blueprint) => blueprint.id === id);
}

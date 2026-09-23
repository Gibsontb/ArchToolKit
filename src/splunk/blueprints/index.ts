/**
 * Every Splunk app, grouped by the tier it is deployed to.
 *
 * The tier is the organising question because it is the one that decides
 * whether a setting does anything at all. A `props.conf` on a search head does
 * not parse data arriving from a forwarder, and the failure is silent — the app
 * deploys, the file is read, and nothing happens. Choosing the tier first makes
 * that a decision rather than a discovery.
 */

import type { BlueprintGroup } from '../../kit/blueprint.ts';
import type { SplunkBlueprint } from '../from-app.ts';
import { TIERS } from '../splunk.ts';
import { SEARCH_HEAD_BLUEPRINTS } from './search-head.ts';
import { INDEXER_BLUEPRINTS } from './indexer.ts';
import { FORWARDER_BLUEPRINTS } from './forwarder.ts';
import { FORWARDER_MORE_BLUEPRINTS } from './forwarder-more.ts';
import { INDEXER_MORE_BLUEPRINTS } from './indexer-more.ts';
import { EDGE_BLUEPRINTS } from './edge.ts';
import { MANAGEMENT_PLATFORM_BLUEPRINTS } from './management-platform.ts';
import { MANAGEMENT_SECURITY_BLUEPRINTS } from './management-security.ts';
import { HEAVY_FORWARDER_BLUEPRINTS } from './heavy-forwarder.ts';
import { CLOUD_BLUEPRINTS } from './cloud.ts';
import { ADDON_BLUEPRINTS } from './addon.ts';
import { SEARCH_HEAD_MORE_BLUEPRINTS } from './search-head-more.ts';

const SEARCH_HEAD = [...SEARCH_HEAD_BLUEPRINTS, ...SEARCH_HEAD_MORE_BLUEPRINTS];
const INDEXER = [...INDEXER_BLUEPRINTS, ...INDEXER_MORE_BLUEPRINTS];
const FORWARDER = [...FORWARDER_BLUEPRINTS, ...FORWARDER_MORE_BLUEPRINTS];
const MANAGEMENT = [...MANAGEMENT_PLATFORM_BLUEPRINTS, ...MANAGEMENT_SECURITY_BLUEPRINTS];

export const SEARCH_HEAD_APPS: BlueprintGroup = { target: 'search_head', label: TIERS.search_head.label, blueprints: SEARCH_HEAD };
export const INDEXER_APPS: BlueprintGroup = { target: 'indexer', label: TIERS.indexer.label, blueprints: INDEXER };
export const FORWARDER_APPS: BlueprintGroup = { target: 'forwarder', label: TIERS.forwarder.label, blueprints: FORWARDER };
export const MANAGEMENT_APPS: BlueprintGroup = { target: 'management', label: 'Management and platform', blueprints: MANAGEMENT };
export const HEAVY_FORWARDER_APPS: BlueprintGroup = { target: 'heavy_forwarder', label: TIERS.heavy_forwarder.label, blueprints: HEAVY_FORWARDER_BLUEPRINTS };
export const ADDON_APPS: BlueprintGroup = { target: 'addon', label: 'Add-ons and onboarding', blueprints: ADDON_BLUEPRINTS };
export const CLOUD_APPS: BlueprintGroup = { target: 'cloud', label: TIERS.cloud.label, blueprints: CLOUD_BLUEPRINTS };
export const EDGE_APPS: BlueprintGroup = { target: 'edge', label: TIERS.edge.label, blueprints: EDGE_BLUEPRINTS };

export const SPLUNK_BLUEPRINTS: readonly BlueprintGroup[] = [ADDON_APPS, MANAGEMENT_APPS, SEARCH_HEAD_APPS, INDEXER_APPS, HEAVY_FORWARDER_APPS, FORWARDER_APPS, EDGE_APPS, CLOUD_APPS];

/** Every Splunk blueprint, with its structured builder, in one list. */
export const SPLUNK_APPS: readonly SplunkBlueprint[] = [...ADDON_BLUEPRINTS, ...MANAGEMENT, ...SEARCH_HEAD, ...INDEXER, ...HEAVY_FORWARDER_BLUEPRINTS, ...FORWARDER, ...EDGE_BLUEPRINTS, ...CLOUD_BLUEPRINTS];

export function splunkApp(id: string): SplunkBlueprint | undefined {
  return SPLUNK_APPS.find((blueprint) => blueprint.id === id);
}

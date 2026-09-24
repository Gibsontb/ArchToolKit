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
import { CLOUD_ACS_BLUEPRINTS } from './cloud-acs.ts';
import { ADDON_BLUEPRINTS } from './addon.ts';
import { ONBOARDING_MORE_BLUEPRINTS } from './onboarding-more.ts';
import { SEARCH_HEAD_MORE_BLUEPRINTS } from './search-head-more.ts';
import { SEARCH_HEAD_KNOWLEDGE_BLUEPRINTS } from './search-head-knowledge.ts';
import { INDEXER_STORAGE_BLUEPRINTS } from './indexer-storage.ts';
import { MANAGEMENT_10X_BLUEPRINTS } from './management-10x.ts';
import { FORWARDER_10X_BLUEPRINTS } from './forwarder-10x.ts';
import { withSplunkChoices } from '../choices.ts';

/** Indexes, sourcetypes, time ranges and the like as dropdowns, the same in every blueprint. */
const withChoices = (list: readonly SplunkBlueprint[]): SplunkBlueprint[] => list.map((b) => ({ ...b, inputs: b.inputs.map((i) => withSplunkChoices(i, b.id)) }));

const SEARCH_HEAD = withChoices([...SEARCH_HEAD_BLUEPRINTS, ...SEARCH_HEAD_MORE_BLUEPRINTS, ...SEARCH_HEAD_KNOWLEDGE_BLUEPRINTS]);
const INDEXER = withChoices([...INDEXER_BLUEPRINTS, ...INDEXER_MORE_BLUEPRINTS, ...INDEXER_STORAGE_BLUEPRINTS]);
// The 10.x forwarder set holds a heavy-forwarder blueprint too (a modular input needs Python): each goes to its own tier.
const FORWARDER = withChoices([...FORWARDER_BLUEPRINTS, ...FORWARDER_MORE_BLUEPRINTS, ...FORWARDER_10X_BLUEPRINTS.filter((b) => b.tier === 'forwarder')]);
const MANAGEMENT = withChoices([...MANAGEMENT_PLATFORM_BLUEPRINTS, ...MANAGEMENT_SECURITY_BLUEPRINTS, ...MANAGEMENT_10X_BLUEPRINTS]);
const HEAVY_FORWARDER = withChoices([...HEAVY_FORWARDER_BLUEPRINTS, ...FORWARDER_10X_BLUEPRINTS.filter((b) => b.tier === 'heavy_forwarder')]);
const ADDON = withChoices([...ADDON_BLUEPRINTS, ...ONBOARDING_MORE_BLUEPRINTS]);
const CLOUD = withChoices([...CLOUD_BLUEPRINTS, ...CLOUD_ACS_BLUEPRINTS]);
const EDGE = withChoices(EDGE_BLUEPRINTS);

export const SEARCH_HEAD_APPS: BlueprintGroup = { target: 'search_head', label: TIERS.search_head.label, blueprints: SEARCH_HEAD };
export const INDEXER_APPS: BlueprintGroup = { target: 'indexer', label: TIERS.indexer.label, blueprints: INDEXER };
export const FORWARDER_APPS: BlueprintGroup = { target: 'forwarder', label: TIERS.forwarder.label, blueprints: FORWARDER };
export const MANAGEMENT_APPS: BlueprintGroup = { target: 'management', label: 'Management and platform', blueprints: MANAGEMENT };
export const HEAVY_FORWARDER_APPS: BlueprintGroup = { target: 'heavy_forwarder', label: TIERS.heavy_forwarder.label, blueprints: HEAVY_FORWARDER };
export const ADDON_APPS: BlueprintGroup = { target: 'addon', label: 'Add-ons and onboarding', blueprints: ADDON };
export const CLOUD_APPS: BlueprintGroup = { target: 'cloud', label: TIERS.cloud.label, blueprints: CLOUD };
export const EDGE_APPS: BlueprintGroup = { target: 'edge', label: TIERS.edge.label, blueprints: EDGE };

export const SPLUNK_BLUEPRINTS: readonly BlueprintGroup[] = [ADDON_APPS, MANAGEMENT_APPS, SEARCH_HEAD_APPS, INDEXER_APPS, HEAVY_FORWARDER_APPS, FORWARDER_APPS, EDGE_APPS, CLOUD_APPS];

/** Every Splunk blueprint, with its structured builder, in one list. */
export const SPLUNK_APPS: readonly SplunkBlueprint[] = [...ADDON, ...MANAGEMENT, ...SEARCH_HEAD, ...INDEXER, ...HEAVY_FORWARDER, ...FORWARDER, ...EDGE, ...CLOUD];

export function splunkApp(id: string): SplunkBlueprint | undefined {
  return SPLUNK_APPS.find((blueprint) => blueprint.id === id);
}

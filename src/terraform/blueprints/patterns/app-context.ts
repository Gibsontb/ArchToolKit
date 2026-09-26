/**
 * `<p>_app_context` (addendum A.2.6): the first item of every app in a stack.
 *
 * It declares what the app's other items and its resource components read:
 * `var.landing_zone` when the landing zone is not in the stack (shared mode;
 * identical to the declaration every other item makes, so the stack keeps
 * one), and `local.app_tags_<app>`, the app's tags as the cloud writes them.
 * The local is named per app, so two apps in one stack do not collide
 * (`tf.stack.duplicate-local`). A resource component's Reference… dropdown
 * offers `local.app_tags_<app>`.
 */

import type { Blueprint, BlueprintValues } from '../../../kit/blueprint.ts';
import type { HclBlock } from '../../hcl.ts';
import { LANDING_ZONE_SOURCE, output, terraformBlock, x, type MigCloud } from '../migration/common.ts';
import { appInputs, appOf, appTagMap, PATTERN_GROUP, patternMainTf, preamble, type PatternPlatform } from './common.ts';
import { hcl } from '../migration/common.ts';

const CLOUD_NAME: Readonly<Record<PatternPlatform, string>> = { aws: 'AWS', azure: 'Azure', google: 'Google Cloud (GCP)', oci: 'OCI', vsphere: 'VCF' };

/** The local an app's tags are kept in. */
export const appTagsLocal = (appId: string): string => `app_tags_${appId}`;

function appContext(platform: PatternPlatform): Blueprint {
  return {
    id: `${platform}_app_context`,
    label: 'App context',
    group: PATTERN_GROUP,
    description: `The app's tags (local.app_tags_<app>: atk_app, atk_component, atk_criticality, atk_owner, atk_cost_centre) for its other items and resource components on ${CLOUD_NAME[platform]}${platform === 'vsphere' ? '' : ', and var.landing_zone when the landing zone is not in the stack'}.`,
    inputs: [...appInputs(), ...(platform === 'vsphere' ? [] : [LANDING_ZONE_SOURCE])],
    emits: [],
    build: (values: BlueprintValues) => {
      const app = appOf(values);
      const local = appTagsLocal(app.id);
      const blocks: HclBlock[] = [
        ...(platform === 'vsphere' ? [terraformBlock(['vsphere'])] : preamble(platform as MigCloud, values)),
        {
          type: 'locals',
          comment: `The tags of ${app.name}: every item of the app writes the same ones on what it builds.`,
          attributes: [{ name: local, value: x(hcl(appTagMap(app, platform), 1)) }],
        },
        output('tags', `local.${local}`, `The tags every resource of ${app.name} carries.`),
      ];
      return { files: { 'main.tf': patternMainTf(blocks, `${CLOUD_NAME[platform]} app context: ${app.name}`) }, findings: [] };
    },
  };
}

export const APP_CONTEXT_BLUEPRINTS: readonly Blueprint[] = (['aws', 'azure', 'google', 'oci', 'vsphere'] as const).map(appContext);

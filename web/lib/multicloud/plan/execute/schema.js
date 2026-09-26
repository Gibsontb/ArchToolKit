/**
 * `status.schema.json`: the JSON Schema (draft 2020-12) of the files the
 * scripts and the tracker exchange (addendum A.11.3). None of them is a
 * settings envelope.
 *
 *   archtoolkit.migration-status    one StatusEvent (types.ts), a line of status/events.jsonl
 *   archtoolkit.migration-gate      a gate file, status/gates/wave-<n>-<gate>.json
 *   archtoolkit.migration-manifest  manifest/items.json (this kit)
 *   archtoolkit.validation          WP-7's validation report (envelope only here)
 *   archtoolkit.discovery           WP-15's discovery file (envelope only here)
 *   archtoolkit.coupling            WP-15's coupling file (envelope only here)
 *
 * The enums come from the option tables, so the schema cannot drift from
 * the types. `statusEventProblems` checks one event the same way, for tests
 * and for anything that wants to check a line without a schema library.
 */

import {
  DB_MOVE_PATH_VALUES, GATE_DECISION_VALUES, GATE_ID_VALUES, ITEM_STATE_VALUES, MOVE_PATH_VALUES, OUTCOME_VALUES, RACI_ROLE_VALUES,
  STATUS_CHANNEL_VALUES, STATUS_EVENT_SOURCE_VALUES, STEP_ID_VALUES,
} from '../options.js';
import { STATUS_EVENT_KIND } from '../types.js';

export const GATE_KIND = 'archtoolkit.migration-gate';
export const MANIFEST_KIND = 'archtoolkit.migration-manifest';
export const VALIDATION_KIND = 'archtoolkit.validation';
export const DISCOVERY_KIND = 'archtoolkit.discovery';
export const COUPLING_KIND = 'archtoolkit.coupling';

const EVENT_PATHS                    = [...MOVE_PATH_VALUES, ...DB_MOVE_PATH_VALUES, ...STATUS_CHANNEL_VALUES];
const ISO_UTC = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$';

                                                

const envelope = (kind        , description        )         => ({
  type: 'object',
  description,
  required: ['kind', 'v'],
  properties: { kind: { const: kind }, v: { const: 1 } },
});

/** The schema document, as an object. */
export function statusSchema()         {
  const statusEvent         = {
    type: 'object',
    description: 'One status event: a line of status/events.jsonl. No user, host or path appears in an event.',
    additionalProperties: false,
    required: ['kind', 'v', 'planId', 'runId', 'at', 'wave', 'item', 'path', 'step', 'outcome', 'dryRun'],
    properties: {
      kind: { const: STATUS_EVENT_KIND },
      v: { const: 1 },
      planId: { type: 'string', minLength: 1 },
      runId: { type: 'string', minLength: 1 },
      at: { type: 'string', pattern: ISO_UTC, description: 'UTC, ISO 8601.' },
      wave: { type: ['integer', 'null'], minimum: 0 },
      item: { type: ['string', 'null'], description: 'The item id, or null for a wave-level event.' },
      name: { type: 'string' },
      path: { enum: EVENT_PATHS },
      step: { enum: STEP_ID_VALUES },
      outcome: { enum: OUTCOME_VALUES },
      dryRun: { type: 'boolean' },
      state: { enum: ITEM_STATE_VALUES },
      detail: { type: 'string', maxLength: 500 },
      data: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      source: { enum: STATUS_EVENT_SOURCE_VALUES },
    },
  };
  const gate         = {
    type: 'object',
    description: 'A gate decision exported by the tracker; the scripts proceed only when decision is "go" for this plan.',
    required: ['kind', 'v', 'planId', 'wave', 'gate', 'decision', 'at', 'criteria'],
    properties: {
      kind: { const: GATE_KIND },
      v: { const: 1 },
      planId: { type: 'string', minLength: 1 },
      wave: { oneOf: [{ type: 'integer', minimum: 0 }, { const: 'programme' }] },
      gate: { enum: GATE_ID_VALUES },
      decision: { enum: GATE_DECISION_VALUES },
      at: { type: 'string', pattern: ISO_UTC },
      by: { enum: RACI_ROLE_VALUES },
      comment: { type: 'string' },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'auto', 'met', 'detail'],
          properties: { id: { type: 'string' }, auto: { type: 'boolean' }, met: { type: 'boolean' }, detail: { type: 'string' } },
        },
      },
    },
  };
  const manifest         = {
    type: 'object',
    description: 'manifest/items.json: every in-scope item with its path, source and target.',
    required: ['kind', 'v', 'planId', 'planId8', 'items'],
    properties: {
      kind: { const: MANIFEST_KIND },
      v: { const: 1 },
      planId: { type: 'string' },
      planId8: { type: 'string', pattern: '^[a-z0-9]{8}$' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'kind', 'app', 'wave', 'path', 'method', 'resource', 'source', 'target'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            kind: { enum: ['workload', 'database'] },
            app: { type: 'string' },
            wave: { type: ['integer', 'null'] },
            path: { enum: [...MOVE_PATH_VALUES, ...DB_MOVE_PATH_VALUES] },
            resource: { type: 'string', pattern: '^atk-[a-z0-9]{8}-[0-9]+-[a-z0-9-]+$', maxLength: 63 },
          },
        },
      },
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'status.schema.json',
    title: 'Migration execution kit: exchanged files',
    oneOf: [
      { $ref: '#/$defs/statusEvent' },
      { $ref: '#/$defs/gate' },
      { $ref: '#/$defs/manifest' },
      { $ref: '#/$defs/validation' },
      { $ref: '#/$defs/discovery' },
      { $ref: '#/$defs/coupling' },
    ],
    $defs: {
      statusEvent,
      gate,
      manifest,
      validation: envelope(VALIDATION_KIND, 'A validation report (WP-7 validate role); only the envelope is checked here.'),
      discovery: envelope(DISCOVERY_KIND, 'A discovery file (WP-15 collectors); only the envelope is checked here.'),
      coupling: envelope(COUPLING_KIND, 'A coupling file (WP-15 coupling scan); only the envelope is checked here.'),
    },
  };
}

export function renderStatusSchema()         {
  return `${JSON.stringify(statusSchema(), null, 2)}\n`;
}

/** What is wrong with one status event (empty when it is valid), checked as the schema does. */
export function statusEventProblems(e         )           {
  const out           = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['not an object'];
  const o = e                           ;
  const allowed = new Set(['kind', 'v', 'planId', 'runId', 'at', 'wave', 'item', 'name', 'path', 'step', 'outcome', 'dryRun', 'state', 'detail', 'data', 'source']);
  for (const k of Object.keys(o)) if (!allowed.has(k)) out.push(`unknown property ${k}`);
  if (o['kind'] !== STATUS_EVENT_KIND) out.push('kind');
  if (o['v'] !== 1) out.push('v');
  for (const k of ['planId', 'runId']) if (typeof o[k] !== 'string' || !(o[k]          ).length) out.push(k);
  if (typeof o['at'] !== 'string' || !new RegExp(ISO_UTC).test(o['at']          )) out.push('at');
  const wave = o['wave'];
  if (!(wave === null || (typeof wave === 'number' && Number.isInteger(wave) && wave >= 0))) out.push('wave');
  if (!(o['item'] === null || typeof o['item'] === 'string')) out.push('item');
  if ('name' in o && typeof o['name'] !== 'string') out.push('name');
  if (!EVENT_PATHS.includes(o['path']          )) out.push('path');
  if (!(STEP_ID_VALUES                     ).includes(o['step']          )) out.push('step');
  if (!(OUTCOME_VALUES                     ).includes(o['outcome']          )) out.push('outcome');
  if (typeof o['dryRun'] !== 'boolean') out.push('dryRun');
  if ('state' in o && !(ITEM_STATE_VALUES                     ).includes(o['state']          )) out.push('state');
  if ('detail' in o && (typeof o['detail'] !== 'string' || (o['detail']          ).length > 500)) out.push('detail');
  if ('data' in o) {
    const d = o['data'];
    if (!d || typeof d !== 'object' || Array.isArray(d)) out.push('data');
    else for (const [k, v] of Object.entries(d)) if (!['string', 'number', 'boolean'].includes(typeof v)) out.push(`data.${k}`);
  }
  if ('source' in o && !(STATUS_EVENT_SOURCE_VALUES                     ).includes(o['source']          )) out.push('source');
  return out;
}

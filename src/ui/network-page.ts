/**
 * Network device generator.
 *
 * The same page as Terraform and Ansible — pick the platform, pick what you
 * are building, fill in the parameters, generate — with one difference that
 * matters: the platform here is a device operating system, not a cloud, so
 * this page keeps its own selection rather than writing into the toolkit-wide
 * cloud. Being on Cisco IOS says nothing about where the Terraform page should
 * open.
 *
 * The build list assembles a whole change: the steps in order, one file each,
 * a playbook that applies them in that order, and a change record whose
 * back-out runs in reverse.
 *
 * A migration plan can send device changes here (`plan-to-network`, addendum
 * A.5.5): the circuit cuts of a data-centre exit. Each arrives as a device, a
 * platform, a blueprint and its values; the page opens on the first, and a
 * banner lists them all so each can be opened in turn. The handoff is consumed
 * once, as every handoff is.
 */

import { mountGeneratorPage } from './generator-page.ts';
import { NETWORK_BLUEPRINTS } from '../network/blueprints/index.ts';
import { buildChange } from '../network/change.ts';
import { catalogFindings } from '../ansible/catalog.ts';
import { takeHandoff } from './handoff.ts';
import { el, append, replace } from './dom.ts';
import { handoffOpening, type NetworkHandoffChange, type PlanToNetworkPayload } from '../multicloud/plan/dcexit/sequence.ts';

const SETTINGS_KIND = 'archtoolkit.network-generator';

function mount(container: HTMLElement, opening?: { readonly blueprint: string; readonly values: Readonly<Record<string, string | number | boolean>> }): void {
  mountGeneratorPage(container, {
    groups: NETWORK_BLUEPRINTS,
    kindLabel: 'device configuration',
    noun: 'change',
    idleHint:
      'Pick a platform and a change, fill in the parameters, then Generate. Every change comes with what to capture first, what proves it worked, and the commands that undo it.',
    settingsKind: SETTINGS_KIND,
    sharedPlatform: false,
    downloadExtension: '.cfg',
    stack: {
      noun: 'change',
      addLabel: 'Add to change',
      referenceLabel: 'an earlier step',
      wrap: (expression) => expression,
      build: (items, blueprintFor, opts) => buildChange(items, blueprintFor, { stackName: opts.stackName }),
    },
    standingFindings: () => catalogFindings(),
    ...(opening ? { openWith: () => opening } : {}),
  });
}

/** Open the generator on one handed-off change: its platform first, then its blueprint and values. */
function openChange(container: HTMLElement, change: NetworkHandoffChange): string | null {
  const opening = handoffOpening(change, NETWORK_BLUEPRINTS);
  if (!opening) return `${change.label}: the ${change.platform} blueprint ${change.blueprint} is not on this page.`;
  try {
    // The page reads its own platform from here when it mounts.
    globalThis.sessionStorage?.setItem(`${SETTINGS_KIND}.platform`, opening.platform);
  } catch {
    // Without storage the page opens on its default platform; the banner still lists the change.
  }
  replace(container);
  mount(container, { blueprint: opening.blueprint, values: opening.values });
  return opening.dropped.length ? `${change.label}: ${opening.dropped.join(', ')} not used by ${change.blueprint}.` : null;
}

function banner(origin: string, changes: readonly NetworkHandoffChange[], container: HTMLElement): HTMLElement {
  const status = el('div', { class: 'section-note' });
  const buttons = changes.map((change, i) =>
    el(
      'li',
      {},
      el('button', {
        class: 'btn btn-small',
        text: 'Open',
        attrs: { type: 'button', title: `Open ${change.blueprint} for ${change.device}` },
        on: {
          click: () => {
            const problem = openChange(container, change);
            replace(status, problem ?? `Opened ${i + 1} of ${changes.length}: ${change.label}.`);
          },
        },
      }),
      el('span', { text: ` ${change.exitWave}${change.date ? ` (${change.date})` : ''} · ${change.label}` }),
    ),
  );
  return el(
    'div',
    { class: 'section-note', style: { marginBottom: 'var(--space-4)' } },
    el('strong', { text: `Device changes from ${origin}. ` }),
    el('span', { text: changes[0]?.note ?? '' }),
    el('ul', {}, ...buttons),
    status,
  );
}

const root = typeof document !== 'undefined' ? document.getElementById('network-root') : null;
if (root) {
  const inbound = takeHandoff<PlanToNetworkPayload>('plan-to-network');
  const changes = Array.isArray(inbound?.payload?.changes) ? inbound.payload.changes : [];
  const container = el('div');
  if (inbound && changes.length > 0) {
    append(root, banner(inbound.origin, changes, container), container);
    const problem = openChange(container, changes[0] as NetworkHandoffChange);
    if (problem) {
      replace(container);
      mount(container);
      append(root, el('div', { class: 'finding is-warning', text: problem }));
    }
  } else {
    append(root, container);
    mount(container);
  }
}

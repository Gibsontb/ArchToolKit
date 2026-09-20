/**
 * Multi-cloud decision matrix page.
 *
 * The question this answers is not "which cloud is best" — nobody can answer
 * that — but "given these constraints, which of the five is left, and why". So
 * the output is a ranking with the rules that produced it, next to the things
 * the rules deliberately refused to decide.
 *
 * An imported estate can be handed straight in from the inventory page, which
 * fills in what an export genuinely supports: how many machines, which guest OS
 * families, how many are large enough to narrow the instance shapes. The three
 * inputs that move the answer most — databases, latency and the deadline — are
 * not in any export, so they are asked for.
 *
 * Once a platform is chosen, the answer goes to the Terraform and Ansible kits
 * rather than staying on the page.
 */

import { el, append, replace } from './dom.ts';
import { card, field, findingsList, numberInput, select, checkbox, verificationBadge, table } from './components.ts';
import { takeHandoff } from './handoff.ts';
import { setTarget, type TargetId } from '../kit/target.ts';
import {
  decide,
  profileFromInventory,
  platformInfo,
  PLATFORMS,
  CAPABILITIES,
  VMWARE_CLOUD_SERVICES,
  serviceOn,
  type Platform,
  type Disposition,
  type Latency,
  type WorkloadProfile,
  type Constraints,
} from '../multicloud/index.ts';
import type { Inventory } from '../vmware/inventory.ts';
import type { Finding } from '../core/findings.ts';

const DISPOSITIONS: { value: Disposition; label: string }[] = [
  { value: 'rehost', label: 'Rehost — move it as it is' },
  { value: 'replatform', label: 'Replatform — same application, managed pieces' },
  { value: 'refactor', label: 'Refactor — rewrite for the platform' },
  { value: 'retain', label: 'Retain — keep it where it is' },
];

const LATENCIES: { value: Latency; label: string }[] = [
  { value: 'tolerant', label: 'Tolerant — nothing it talks to stays behind' },
  { value: 'sensitive', label: 'Sensitive — needs a private circuit' },
  { value: 'critical', label: 'Critical — milliseconds to something that stays' },
];

const OS_FAMILIES = [
  { value: 'mixed', label: 'Mixed' },
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
] as const;

const DATABASES = ['oracle', 'sqlserver', 'postgres', 'mysql'] as const;

interface Controls {
  disposition: HTMLSelectElement;
  vmCount: HTMLInputElement;
  osFamily: HTMLSelectElement;
  latency: HTMLSelectElement;
  timeline: HTMLInputElement;
  databases: Record<string, HTMLInputElement>;
  largeMemory: HTMLInputElement;
  dongle: HTMLInputElement;
  gpu: HTMLInputElement;
  commitment: Partial<Record<Platform, HTMLInputElement>>;
  skills: Partial<Record<Platform, HTMLInputElement>>;
  excluded: Partial<Record<Platform, HTMLInputElement>>;
  portableVcf: HTMLInputElement;
  softwareAssurance: HTMLInputElement;
  residency: HTMLInputElement;
  sovereignty: HTMLInputElement;
}

function textInput(value: string, placeholder = ''): HTMLInputElement {
  const node = el('input', { attrs: { type: 'text', value, placeholder } }) as HTMLInputElement;
  node.value = value;
  return node;
}

function checked(map: Partial<Record<Platform, HTMLInputElement>>): Platform[] {
  return (Object.entries(map) as [Platform, HTMLInputElement][])
    .filter(([, input]) => input.checked)
    .map(([platform]) => platform);
}

export function mountMulticloudPage(root: HTMLElement): void {
  // Declared before anything that can reach them. A `let` below the code that
  // uses it left an earlier page dead on arrival whenever a handoff was
  // present, and neither the tests nor the typechecker noticed.
  let lastRenderKey = '';
  let inventoryFindings: readonly Finding[] = [];
  let inventoryOrigin: string | undefined;

  const controls = { databases: {}, commitment: {}, skills: {}, excluded: {} } as Controls;
  const outputPane = el('div', { class: 'stack' });
  const banner = el('div', { class: 'stack' });
  const inputsPane = buildInputs(controls, () => render());

  append(root, banner, el('div', { class: 'split' }, el('div', {}, inputsPane), outputPane));

  // --- an estate handed over from the inventory page ------------------------
  const handoff = takeHandoff<Inventory>('inventory-to-multicloud');
  if (handoff) {
    const derived = profileFromInventory(handoff.payload, { disposition: 'rehost' });
    inventoryFindings = derived.findings;
    inventoryOrigin = handoff.origin;
    controls.vmCount.value = String(derived.evidence.vmCount);
    if (derived.profile.osFamily) controls.osFamily.value = derived.profile.osFamily;
    if (derived.profile.specialHardware?.includes('large-memory')) {
      controls.largeMemory.checked = true;
    }
    append(
      banner,
      el(
        'div',
        { class: 'section-note' },
        el('strong', { text: 'Prefilled from your inventory — ' }),
        el('span', { text: handoff.origin }),
        el('span', {
          class: 'muted',
          text: ' · Databases, latency and the deadline are not in any export; set them below.',
        }),
      ),
    );
  }

  function currentProfile(): WorkloadProfile {
    const databases = DATABASES.filter((d) => controls.databases[d]?.checked);
    const hardware: ('gpu' | 'large-memory' | 'physical-dongle')[] = [];
    if (controls.gpu.checked) hardware.push('gpu');
    if (controls.largeMemory.checked) hardware.push('large-memory');
    if (controls.dongle.checked) hardware.push('physical-dongle');
    const timeline = Number(controls.timeline.value);

    return {
      disposition: controls.disposition.value as Disposition,
      vmCount: Math.max(0, Number(controls.vmCount.value) || 0),
      osFamily: controls.osFamily.value as WorkloadProfile['osFamily'],
      latencyToOnPrem: controls.latency.value as Latency,
      ...(databases.length > 0 ? { databases } : {}),
      ...(hardware.length > 0 ? { specialHardware: hardware } : {}),
      ...(Number.isFinite(timeline) && timeline > 0 ? { timelineMonths: timeline } : {}),
    };
  }

  function currentConstraints(): Constraints {
    return {
      existingCommitment: checked(controls.commitment),
      skills: checked(controls.skills),
      excluded: checked(controls.excluded),
      portableVcfSubscription: controls.portableVcf.checked,
      microsoftSoftwareAssurance: controls.softwareAssurance.checked,
      ...(controls.residency.value.trim() ? { dataResidency: controls.residency.value.trim() } : {}),
      sovereigntyRequired: controls.sovereignty.checked,
    };
  }

  function render(): void {
    const profile = currentProfile();
    const constraints = currentConstraints();
    const key = JSON.stringify({ profile, constraints });
    if (key === lastRenderKey) return;
    lastRenderKey = key;

    const decision = decide(profile, constraints);
    const sections: HTMLElement[] = [];

    // --- the ranking --------------------------------------------------------
    const rows: HTMLElement[] = [];
    for (const entry of decision.ranked) {
      const meta = platformInfo(entry.platform);
      const isLeader = decision.recommended === entry.platform;
      rows.push(
        el(
          'div',
          {
            class: 'section-note',
            style: {
              marginTop: 'var(--space-3)',
              opacity: entry.eliminated ? '0.55' : '1',
            },
          },
          el(
            'div',
            {},
            el('strong', { text: meta.label }),
            el('span', {
              class: 'muted',
              text: entry.eliminated ? '  ruled out' : `  ${entry.score >= 0 ? '+' : ''}${entry.score}`,
            }),
            isLeader ? el('span', { class: 'badge badge-verified', text: ' recommended' }) : null,
          ),
          entry.reasons.length === 0
            ? el('div', { class: 'muted', text: 'Nothing in these constraints moved it either way.' })
            : el(
                'ul',
                { class: 'finding-list' },
                ...entry.reasons.map((r) =>
                  el(
                    'li',
                    {},
                    el('code', { text: `${r.delta > 0 ? '+' : ''}${r.delta}` }),
                    el('span', { text: `  ${r.reason}` }),
                  ),
                ),
              ),
        ),
      );
    }
    sections.push(card('Ranking', ...rows));

    // --- what to do next ----------------------------------------------------
    if (decision.handoff) {
      const meta = platformInfo(decision.handoff.platform);
      // The matrix is where the platform gets decided, so this is where it gets
      // set. The generators read it, which is why they do not ask again.
      setTarget(
        (decision.handoff.platform === 'vmware' ? 'vsphere' : decision.handoff.platform) as TargetId,
        'set by the decision matrix',
      );
      sections.push(
        card(
          'What to generate next',
          el('p', {
            text: decision.handoff.vmwareService
              ? `A rehost onto ${meta.shortLabel} means ${decision.handoff.vmwareService}: the guest does not change, so the estate keeps its vSphere tooling and the toolkit's VCF pages still apply.`
              : `${meta.label} is the landing place. Generate its network foundation and repository spine, then fill in the workloads.`,
          }),
          el(
            'div',
            { class: 'btn-row', style: { marginTop: 'var(--space-4)' } },
            el('button', {
              class: 'btn btn-primary',
              text: `Terraform for ${meta.shortLabel}`,
              on: { click: () => globalThis.location.assign('terraform.html') },
            }),
            el('button', {
              class: 'btn',
              text: `Ansible for ${meta.shortLabel}`,
              on: { click: () => globalThis.location.assign('ansible.html') },
            }),
            decision.handoff.vmwareService
              ? el('button', {
                  class: 'btn',
                  text: 'Size the VCF estate',
                  on: { click: () => globalThis.location.assign('vcf-sizing.html') },
                })
              : null,
          ),
          el('div', {
            class: 'section-note',
            style: { marginTop: 'var(--space-3)' },
            text: `Terraform provider "${decision.handoff.terraformTarget}", Ansible collection family "${decision.handoff.ansibleTarget}".`,
          }),
        ),
      );
    }

    // --- the VMware services -----------------------------------------------
    if (profile.disposition === 'rehost' || profile.disposition === 'retain') {
      sections.push(
        card(
          'VMware on each cloud',
          el('p', {
            class: 'muted',
            text: 'The only path that moves a vSphere estate without rewriting it. Each claim carries how it was verified.',
          }),
          ...VMWARE_CLOUD_SERVICES.map((service) =>
            el(
              'div',
              { class: 'section-note', style: { marginTop: 'var(--space-3)' } },
              el('div', {}, el('strong', { text: `${service.name} (${service.abbreviation})` })),
              el(
                'div',
                {},
                el('span', { text: `VCF: ${service.vcfVersions.value.join(', ') || 'not confirmed'}  ` }),
                verificationBadge(service.vcfVersions.verification),
              ),
              el(
                'div',
                {},
                el('span', { text: `Licensing: ${service.licensing.value}  ` }),
                verificationBadge(service.licensing.verification),
              ),
              service.vcfVersions.caveat
                ? el('div', { class: 'muted', text: service.vcfVersions.caveat })
                : null,
            ),
          ),
        ),
      );
    }

    // --- the capability matrix ----------------------------------------------
    const survivors = decision.ranked.filter((r) => !r.eliminated).map((r) => r.platform);
    sections.push(
      card(
        'Capability matrix',
        el('p', {
          class: 'muted',
          text: 'Product names are indicative. The Terraform resource type under each is checked against the committed provider catalog, so a blank is a genuine gap.',
        }),
        table(
          [
            { header: 'Capability', render: (row: (typeof CAPABILITIES)[number]) => row.label },
            ...survivors.map((platform) => ({
              header: platformInfo(platform).shortLabel,
              render: (row: (typeof CAPABILITIES)[number]) =>
                serviceOn(row.capability, platform)?.name ?? '\u2014',
            })),
          ],
          CAPABILITIES,
        ),
      ),
    );

    sections.push(
      card(
        'Findings',
        findingsList([...inventoryFindings, ...decision.findings], 'Nothing to report.'),
      ),
    );

    replace(outputPane, ...sections);
  }

  render();
}

function platformBoxes(
  map: Partial<Record<Platform, HTMLInputElement>>,
  bind: <T extends HTMLElement>(node: T) => T,
): HTMLElement[] {
  return PLATFORMS.map((platform) => {
    const box = checkbox(platformInfo(platform).shortLabel, false);
    map[platform] = bind(box.input);
    return el('div', { class: 'field' }, box.wrap);
  });
}

function buildInputs(controls: Controls, onChange: () => void): HTMLElement {
  const bind = <T extends HTMLElement>(node: T): T => {
    node.addEventListener('change', onChange);
    node.addEventListener('input', onChange);
    return node;
  };

  controls.disposition = bind(select(DISPOSITIONS, 'rehost'));
  controls.vmCount = bind(numberInput(250, { min: 0, max: 100000 }));
  controls.osFamily = bind(select(OS_FAMILIES, 'mixed'));
  controls.latency = bind(select(LATENCIES, 'tolerant'));
  controls.timeline = bind(numberInput(12, { min: 0, max: 120 }));
  controls.residency = bind(textInput('', 'Country or region data must stay in'));

  const dbBoxes = DATABASES.map((db) => {
    const label = {
      oracle: 'Oracle Database',
      sqlserver: 'SQL Server',
      postgres: 'PostgreSQL',
      mysql: 'MySQL',
    }[db];
    const box = checkbox(label, false);
    controls.databases[db] = bind(box.input);
    return el('div', { class: 'field' }, box.wrap);
  });

  const gpuBox = checkbox('GPU', false);
  const memBox = checkbox('Very large memory footprints', false);
  const dongleBox = checkbox('Physical licence dongle', false);
  controls.gpu = bind(gpuBox.input);
  controls.largeMemory = bind(memBox.input);
  controls.dongle = bind(dongleBox.input);

  const vcfBox = checkbox('Portable VCF subscriptions held', false);
  const saBox = checkbox('Microsoft licences with Software Assurance', false);
  const sovBox = checkbox('Sovereign or air-gapped required', false);
  controls.portableVcf = bind(vcfBox.input);
  controls.softwareAssurance = bind(saBox.input);
  controls.sovereignty = bind(sovBox.input);

  return el(
    'div',
    { class: 'stack' },
    card(
      'The workload',
      field('Disposition', controls.disposition),
      field('Virtual machines', controls.vmCount),
      field('Guest OS', controls.osFamily),
      field('Latency to what stays behind', controls.latency),
      field('Months until it must be off current hardware', controls.timeline, '0 for no deadline.'),
    ),
    card('Databases', ...dbBoxes),
    card('Hardware', el('div', { class: 'field' }, gpuBox.wrap), el('div', { class: 'field' }, memBox.wrap), el('div', { class: 'field' }, dongleBox.wrap)),
    card('Already committed to', ...platformBoxes(controls.commitment, bind)),
    card('Team can operate', ...platformBoxes(controls.skills, bind)),
    card('Ruled out by policy', ...platformBoxes(controls.excluded, bind)),
    card(
      'Licensing and regulation',
      el('div', { class: 'field' }, vcfBox.wrap),
      el('div', { class: 'field' }, saBox.wrap),
      el('div', { class: 'field' }, sovBox.wrap),
      field('Data residency', controls.residency),
    ),
  );
}

const root = document.getElementById('multicloud-root');
if (root) mountMulticloudPage(root);

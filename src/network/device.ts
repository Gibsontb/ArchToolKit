/**
 * A network change: the configuration, how to check it, and how to undo it.
 *
 * A Terraform plan can be read before it runs and a playbook has `--check`.
 * A router does not: the moment a line is pasted, it is live, and a wrong
 * access list or a VLAN missing from a trunk takes a site off the network with
 * no undo. So nothing here emits configuration on its own. Every blueprint
 * produces four things together, and the file carries all four:
 *
 *   1. what to capture *before* the change, so there is something to compare to;
 *   2. the configuration itself;
 *   3. what to run *after* to prove it worked;
 *   4. the back-out — the exact commands that put it back.
 *
 * That is also what a change record needs, which is the other half of why it
 * is generated rather than written by hand at 2am.
 *
 * The same change can be applied two ways: pasted into a session, or pushed by
 * Ansible. Both come out of one structure, so they cannot disagree.
 */

import type { Finding } from '../core/findings.ts';
import { info, warning } from '../core/findings.ts';

export type Platform = 'cisco_ios' | 'cisco_nxos' | 'cisco_wlc' | 'cisco_asa' | 'arista_eos' | 'panos' | 'fortios' | 'f5';

export interface PlatformInfo {
  readonly id: Platform;
  readonly label: string;
  /** What the vendor calls the thing being configured. */
  readonly device: string;
  /** The comment marker its configuration accepts. */
  readonly comment: string;
  /** The Ansible collection that pushes it. */
  readonly collection: string;
  /** `ansible_network_os`, where the connection needs one. */
  readonly networkOs?: string;
  /** How the change is saved once it is right. */
  readonly save: string;
  /** The file extension a generated change gets. */
  readonly extension: string;
}

export const PLATFORMS: Readonly<Record<Platform, PlatformInfo>> = {
  cisco_ios: {
    id: 'cisco_ios',
    label: 'Cisco IOS / IOS-XE',
    device: 'switch or router',
    comment: '!',
    collection: 'cisco.ios',
    networkOs: 'cisco.ios.ios',
    save: 'write memory',
    extension: '.cfg',
  },
  cisco_nxos: {
    id: 'cisco_nxos',
    label: 'Cisco NX-OS',
    device: 'Nexus switch',
    comment: '!',
    collection: 'cisco.nxos',
    networkOs: 'cisco.nxos.nxos',
    save: 'copy running-config startup-config',
    extension: '.cfg',
  },
  cisco_wlc: {
    id: 'cisco_wlc',
    label: 'Cisco Catalyst 9800 (wireless)',
    device: 'wireless LAN controller',
    comment: '!',
    // The 9800 is IOS-XE, so the IOS collection drives it.
    collection: 'cisco.ios',
    networkOs: 'cisco.ios.ios',
    save: 'write memory',
    extension: '.cfg',
  },
  cisco_asa: {
    id: 'cisco_asa',
    label: 'Cisco ASA (firewall)',
    device: 'firewall',
    comment: '!',
    collection: 'cisco.asa',
    networkOs: 'cisco.asa.asa',
    save: 'write memory',
    extension: '.cfg',
  },
  arista_eos: {
    id: 'arista_eos',
    label: 'Arista EOS',
    device: 'switch',
    comment: '!',
    collection: 'arista.eos',
    networkOs: 'arista.eos.eos',
    save: 'write memory',
    extension: '.cfg',
  },
  panos: {
    id: 'panos',
    label: 'Palo Alto PAN-OS',
    device: 'firewall or Panorama',
    comment: '#',
    collection: 'paloaltonetworks.panos',
    save: 'commit',
    extension: '.txt',
  },
  fortios: {
    id: 'fortios',
    label: 'Fortinet FortiOS',
    device: 'FortiGate',
    comment: '#',
    collection: 'fortinet.fortios',
    save: 'the change applies as each `end` is entered; back it up with `execute backup config`',
    extension: '.txt',
  },
  f5: {
    id: 'f5',
    label: 'F5 BIG-IP (AS3)',
    device: 'BIG-IP',
    comment: '//',
    collection: 'f5networks.f5_modules',
    save: 'the declaration is the configuration; save with `tmsh save sys config` after it applies',
    extension: '.json',
  },
};

/** How risky a change is to the traffic already flowing through the device. */
export type Impact =
  /** Nothing in the path changes: adding an object, a description, a monitor. */
  | 'none'
  /** Traffic can move or drop briefly: a trunk, a port-channel, a routing change. */
  | 'brief'
  /** Something goes down until the change completes: an interface, a VIP, a reload. */
  | 'outage';

export const IMPACT_MEANING: Readonly<Record<Impact, string>> = {
  none: 'No effect on traffic already flowing: this adds configuration that nothing is using yet.',
  brief: 'Traffic can move or drop for a moment while this converges. Do it in a window unless the path is redundant and proven.',
  outage: 'Something stops passing traffic until this is complete. This needs a change window and someone watching.',
};

/** How Ansible would apply the same change. */
export interface Push {
  /** Fully qualified module, e.g. `cisco.ios.ios_config`. */
  readonly module: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Extra tasks that belong with it, such as saving or a verification. */
  readonly after?: readonly { readonly name: string; readonly module: string; readonly args: Readonly<Record<string, unknown>> }[];
  /** Where the play runs: the inventory group the device is in. */
  readonly hosts?: string;
}

export interface DeviceChange {
  readonly platform: Platform;
  /** What this change does, in a line a change record can carry. */
  readonly title: string;
  readonly impact: Impact;
  /** What to capture before touching anything. */
  readonly before: readonly string[];
  /** The configuration itself, in the device's own syntax. */
  readonly config: readonly string[];
  /** What proves it worked, run after. */
  readonly verify: readonly string[];
  /** The exact commands that put it back. */
  readonly backout: readonly string[];
  /** Anything the person applying it has to know: prerequisites, warnings. */
  readonly notes?: readonly string[];
  readonly push?: Push;
  readonly findings?: readonly Finding[];
}

const rule = (comment: string, text: string): string => `${comment} ${'-'.repeat(2)} ${text} ${'-'.repeat(Math.max(2, 68 - text.length))}`;

function section(comment: string, heading: string, lines: readonly string[], prefix = ''): string[] {
  if (lines.length === 0) return [];
  return [rule(comment, heading), ...lines.map((line) => (prefix && line.trim() !== '' ? `${prefix}${line}` : line)), ''];
}

/**
 * The change as one file: the header, what to capture first, the configuration,
 * the checks and the back-out.
 *
 * The parts that are not configuration are commented out in the device's own
 * comment syntax, so the whole file can be pasted into a session and only the
 * configuration takes effect. That is how it will be used whatever anyone
 * intends: someone will select all and paste.
 */
export function renderChange(change: DeviceChange, name: string): string {
  const platform = PLATFORMS[change.platform];
  const c = platform.comment;
  const lines: string[] = [
    `${c} ${change.title}`,
    `${c} ${platform.label} — generated by ArchToolKit.`,
    `${c}`,
    `${c} Impact: ${IMPACT_MEANING[change.impact]}`,
    `${c} Save:   ${platform.save}`,
    `${c}`,
    `${c} Everything outside the configuration block is commented out, so this file`,
    `${c} can be pasted whole. Read it first: it is a draft for review, not a`,
    `${c} change that has been approved for your network.`,
    '',
  ];

  if (change.notes && change.notes.length > 0) {
    lines.push(...section(c, 'before you start', change.notes.map((n) => `${c} ${n}`)));
  }
  lines.push(...section(c, 'capture first', change.before.map((cmd) => `${c}   ${cmd}`)));
  lines.push(...section(c, `configuration — ${name || 'change'}`, change.config));
  lines.push(...section(c, 'verify', change.verify.map((cmd) => `${c}   ${cmd}`)));
  lines.push(...section(c, 'back out', change.backout.map((cmd) => `${c}   ${cmd}`)));

  return `${lines.join('\n').trimEnd()}\n`;
}

/** The change record: the same four parts, as text for a ticket. */
export function renderRecord(change: DeviceChange, name: string): string[] {
  const platform = PLATFORMS[change.platform];
  return [
    `### ${name || change.title}`,
    '',
    `**What:** ${change.title}  `,
    `**Where:** ${platform.label} (${platform.device})  `,
    `**Impact:** ${IMPACT_MEANING[change.impact]}`,
    '',
    ...(change.notes && change.notes.length > 0 ? ['**Before you start**', '', ...change.notes.map((n) => `- ${n}`), ''] : []),
    '**Capture first**',
    '',
    ...change.before.map((cmd) => `- \`${cmd}\``),
    '',
    '**Verify**',
    '',
    ...change.verify.map((cmd) => `- \`${cmd}\``),
    '',
    '**Back out**',
    '',
    '```',
    ...change.backout,
    '```',
    '',
  ];
}

/** Findings every change gets, on top of whatever the blueprint found. */
export function standingFindings(change: DeviceChange): Finding[] {
  const out: Finding[] = [];
  if (change.backout.length === 0) {
    out.push(
      warning('network.change.no-backout', 'This change has no back-out written, so put one in the change record before it is applied.', {
        source: 'ArchToolKit',
      }),
    );
  }
  if (change.impact !== 'none') {
    out.push(
      warning('network.change.impact', IMPACT_MEANING[change.impact], {
        remediation: 'Confirm the window and that the path is redundant before applying it.',
        source: 'ArchToolKit',
      }),
    );
  }
  out.push(
    info('network.change.review', 'Configuration is generated from the answers on this page. Diff it against the running configuration before you paste it.', {
      source: 'ArchToolKit',
    }),
  );
  return out;
}

/* -------------------------------------------------------------------------- *
 * Small syntax helpers the blueprints share
 * -------------------------------------------------------------------------- */

/** A list typed as "1,2,5-8" or "Gi1/0/1, Gi1/0/2", cleaned up. */
export function listOf(value: string): string[] {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** VLAN ids from "10,20,30-32", in order, deduplicated, 1–4094 only. */
export function vlanIds(value: string): number[] {
  const out = new Set<number>();
  for (const part of listOf(value)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) if (i >= 1 && i <= 4094) out.add(i);
      continue;
    }
    const one = Number(part);
    if (Number.isInteger(one) && one >= 1 && one <= 4094) out.add(one);
  }
  return [...out].sort((a, b) => a - b);
}

/** "10,20,30-32" back from a list of ids, collapsing runs. */
export function vlanRange(ids: readonly number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let previous: number | null = null;
  const flush = () => {
    if (start === null || previous === null) return;
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
  };
  for (const id of sorted) {
    if (start === null) {
      start = id;
      previous = id;
      continue;
    }
    if (previous !== null && id === previous + 1) {
      previous = id;
      continue;
    }
    flush();
    start = id;
    previous = id;
  }
  flush();
  return parts.join(',');
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(value: string): boolean {
  const match = IPV4.exec(String(value ?? '').trim());
  if (!match) return false;
  return match.slice(1).every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255 && String(n) === String(Number(octet));
  });
}

/** "10.0.0.0/24" split into address and prefix length. */
export function parseCidr(value: string): { address: string; prefix: number } | null {
  const [address, prefix] = String(value ?? '').trim().split('/');
  if (!address || !isIpv4(address)) return null;
  const length = Number(prefix);
  if (!Number.isInteger(length) || length < 0 || length > 32) return null;
  return { address, prefix: length };
}

/** A prefix length as the dotted mask IOS and PAN-OS want in places. */
export function netmask(prefix: number): string {
  const bits = Math.max(0, Math.min(32, Math.trunc(prefix)));
  const value = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/** The wildcard mask IOS access lists and OSPF network statements want. */
export function wildcard(prefix: number): string {
  return netmask(prefix)
    .split('.')
    .map((octet) => 255 - Number(octet))
    .join('.');
}

/** A description safe to put on an interface: no control characters, bounded. */
export function description(value: string, fallback: string): string {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return (text || fallback).slice(0, 200);
}

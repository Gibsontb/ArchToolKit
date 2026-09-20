/**
 * The platform, chosen once.
 *
 * Picking the cloud on every page is the kind of thing that is merely annoying
 * the first time and then quietly becomes the reason a tool goes unused. It is
 * also a correctness problem: two pages that each hold their own idea of the
 * target will disagree, and the Terraform and the Ansible will be for different
 * clouds without saying so.
 *
 * So the target lives in one place. The multi-cloud matrix sets it when it
 * reaches a recommendation, the generator pages read it and offer it as the
 * current selection, and changing it anywhere changes it everywhere.
 *
 * `sessionStorage` is the right store: it survives navigating between pages in a
 * tab and goes away with the tab, which is the correct lifetime for "the cloud I
 * am working on right now". Every access is wrapped, because storage throws in a
 * private window and with site data blocked, and a toolkit that fails to load
 * because it could not read a convenience would be a poor trade.
 */

export type TargetId = 'vcf' | 'vsphere' | 'aws' | 'azure' | 'google' | 'oci' | 'linux' | 'windows';

const KEY = 'archtoolkit.target';
const VERSION = 1;

interface StoredTarget {
  readonly version: number;
  readonly target: TargetId;
  /** How it came to be selected, shown so the choice is not mysterious. */
  readonly origin?: string;
}

const VALID: readonly TargetId[] = [
  'vcf',
  'vsphere',
  'aws',
  'azure',
  'google',
  'oci',
  'linux',
  'windows',
];

function store(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function setTarget(target: TargetId, origin?: string): void {
  try {
    const payload: StoredTarget = { version: VERSION, target, ...(origin ? { origin } : {}) };
    store()?.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Not being able to remember the selection is survivable; failing is not.
  }
}

export function getTarget(): { target: TargetId; origin?: string } | null {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredTarget;
    if (parsed?.version !== VERSION) return null;
    if (!VALID.includes(parsed.target)) return null;
    return { target: parsed.target, ...(parsed.origin ? { origin: parsed.origin } : {}) };
  } catch {
    return null;
  }
}

export function clearTarget(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // As above.
  }
}

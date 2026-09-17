/**
 * Capacity units.
 *
 * Sizing data arrives in a mix of GB/GiB/TiB from vendor tables, RVTools (MiB)
 * and the vSphere API (MiB/KiB). Mixing them silently is how a sizing tool ends
 * up 7% wrong, so every number is normalised to GiB at the boundary and the
 * conversion is explicit.
 */

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;
export const TIB = 1024 * GIB;

export function mibToGib(mib: number): number {
  return mib / 1024;
}

export function gibToTib(gib: number): number {
  return gib / 1024;
}

export function tibToGib(tib: number): number {
  return tib * 1024;
}

export function bytesToGib(bytes: number): number {
  return bytes / GIB;
}

/**
 * Vendor "GB" in VMware sizing tables is almost always GiB. This alias exists so
 * call sites can record which interpretation they intended rather than leaving
 * it implicit.
 */
export function vendorGbToGib(gb: number): number {
  return gb;
}

export function roundTo(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Human-readable capacity, choosing GiB or TiB by magnitude. */
export function formatCapacityGib(gib: number): string {
  if (!Number.isFinite(gib)) return '—';
  if (Math.abs(gib) >= 1024) return `${roundTo(gibToTib(gib), 2)} TiB`;
  return `${roundTo(gib, gib < 10 ? 1 : 0)} GiB`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

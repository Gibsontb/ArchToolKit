/**
 * What every Junos blueprint shares: the platform, the placeholder, and the
 * small syntax rules Junos is strict about.
 *
 * Junos configuration here is `set` and `delete` commands — what
 * `show configuration | display set` prints and `load set terminal` takes —
 * because that is the form that pastes, diffs and loads line by line. The
 * back-out is `delete` of the same hierarchy, and every change is meant to go
 * in with `commit confirmed`, so a change that cuts off the session rolls
 * itself back.
 */

import { error, warning,              } from '../../core/findings.js';
import { listOf, parseCidrDual } from '../device.js';

export const PLATFORM = 'juniper_junos'         ;
export const SECRET = '<REQUIRED>';
export const SRC = { source: 'ArchToolKit' }         ;

/** The note every change that could cut off its own session carries. */
export const COMMIT_CONFIRMED =
  'Load with `load set terminal` (or `load merge set <file>`), check with `show | compare` and `commit check`, then `commit confirmed 5`. If the session is lost, Junos rolls back on its own; if all is well, `commit` again within five minutes to keep it.';

/** A value Junos takes as one token: quoted when it has a space or a special character. */
export function q(value        )         {
  const text = String(value ?? '').replace(/"/g, "'").replace(/[\r\n\t]+/g, ' ').trim();
  return /^[A-Za-z0-9_.:/\-]+$/.test(text) ? text : `"${text}"`;
}

/** A configuration object name: letters, digits, dash and underscore. */
export function ident(value        , fallback        )         {
  const text = String(value ?? '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  return text === '' ? fallback : text.slice(0, 63);
}

/** Physical and logical interface names Junos uses. */
const IFD = /^((ge|xe|et|mge|fe|xle|fte|gr|lt|ip|vt)-\d+\/\d+\/\d+(:\d+)?|(ae|reth|st|lo|irb|vlan|fxp|em|me|vme|gr|fab|swfab)\d*)$/;

/** "ge-0/0/1.100" split into the interface and the unit (0 when none is given). */
export function ifl(name        )                                              {
  const [ifd = '', unit] = String(name ?? '').trim().split('.');
  const n = unit === undefined || unit === '' ? 0 : Number(unit);
  const u = Number.isInteger(n) && n >= 0 ? n : 0;
  return { ifd, unit: u, text: `${ifd}.${u}` };
}

/** A warning for each name that does not look like a Junos interface. */
export function interfaceFindings(names                   , code = 'network.junos.interface-name')            {
  return names
    .filter((name) => !IFD.test(ifl(name).ifd))
    .map((name) =>
      warning(code, `"${name}" does not look like a Junos interface name (ge-0/0/1, xe-0/0/48, et-0/0/0, ae0, irb, lo0).`, {
        remediation: 'Use the name `show interfaces terse` prints. A Cisco-style name is rejected at commit.',
        ...SRC,
      }),
    );
}

/** Interfaces from a list, without units: the ports themselves. */
export function ports(value        )           {
  return [...new Set(listOf(value).map((p) => ifl(p).ifd).filter(Boolean))];
}

/** Logical interfaces from a list: "ge-0/0/0" becomes "ge-0/0/0.0". */
export function logicals(value        )           {
  return [...new Set(listOf(value).map((p) => ifl(p).text).filter((t) => t !== '.0'))];
}

/** An OSPF / IS-IS area as Junos writes it: 0 becomes 0.0.0.0. */
export function dottedArea(value        )                {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n > 0xffffffff) return null;
    return [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff).join('.');
  }
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(text) && text.split('.').every((o) => Number(o) <= 255) ? text : null;
}

/** Prefixes from a list, split by family, with the unreadable ones kept apart. */
export function prefixes(value        )                                                    {
  const out = { v4: []            , v6: []            , invalid: []             };
  for (const item of listOf(value)) {
    const c = parseCidrDual(item);
    if (!c) out.invalid.push(item);
    else (c.family === 4 ? out.v4 : out.v6).push(`${c.network}/${c.prefix}`);
  }
  return out;
}

/** An error for each entry that is not a prefix. */
export function prefixFindings(code        , label        , invalid                   )            {
  return invalid.map((item) =>
    error(code, `"${item}" in ${label} is not a valid IPv4 or IPv6 prefix.`, { remediation: 'Write it as 10.0.0.0/24 or 2001:db8:10::/64.', ...SRC }),
  );
}

/** Route distinguisher or route target value: ASN:n or IPv4:n. */
export function isRdValue(value        )          {
  const m = /^([^:]+):(\d+)$/.exec(String(value ?? '').trim());
  if (!m) return false;
  const left = m[1]          ;
  if (/^\d+$/.test(left)) return Number(left) <= 4294967295;
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(left) && left.split('.').every((o) => Number(o) <= 255);
}

/** An STP bridge priority as Junos writes it: 4096 is 4k. */
export function bridgePriority(value        )         {
  return value === 0 ? '0' : `${value / 1024}k`;
}

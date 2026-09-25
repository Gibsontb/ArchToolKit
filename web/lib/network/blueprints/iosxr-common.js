/**
 * Shared pieces for the Cisco IOS-XR blueprints.
 *
 * IOS-XR is not IOS: configuration is staged in a target buffer and applied at
 * `commit`, addresses take a dotted mask (`ipv4 address 10.0.0.1 255.255.255.0`),
 * routing protocols carry their interfaces under the process, and an eBGP
 * session passes nothing at all until a route-policy is attached. So these are
 * written for IOS-XR rather than translated from the IOS group.
 */

import { warning,              } from '../../core/findings.js';
import { netmask,                   } from '../device.js';
import { deviceBlueprint,                      } from '../from-change.js';
                                                              
                                                   

export const PLATFORM = 'cisco_iosxr'         ;
export const SECRET = '<REQUIRED>';
export const SRC = { source: 'ArchToolKit' }         ;

/** `ipv4 address a.b.c.d mask` / `ipv6 address x/len`, as IOS-XR writes them. */
export function xrAddress(c          )         {
  return c.family === 4 ? `ipv4 address ${c.address} ${netmask(c.prefix)}` : `ipv6 address ${c.text}`;
}

/** An IOS-XR interface name, with the common short forms expanded. */
export function xrInterface(value        , fallback        )         {
  const text = String(value ?? '').trim() || fallback;
  const forms                     = [
    [/^(gigabitethernet|gig|gi)\s*(?=\d)/i, 'GigabitEthernet'],
    [/^(tengige|ten|te)\s*(?=\d)/i, 'TenGigE'],
    [/^(twentyfivegige|twe)\s*(?=\d)/i, 'TwentyFiveGigE'],
    [/^(fortygige|fo)\s*(?=\d)/i, 'FortyGigE'],
    [/^(hundredgige|hu)\s*(?=\d)/i, 'HundredGigE'],
    [/^(fourhundredgige|fh)\s*(?=\d)/i, 'FourHundredGigE'],
    [/^(bundle-ether|be)\s*(?=\d)/i, 'Bundle-Ether'],
    [/^(loopback|lo)\s*(?=\d)/i, 'Loopback'],
  ];
  for (const [pattern, full] of forms) {
    if (pattern.test(text)) return `${full}${text.replace(pattern, '')}`;
  }
  return text;
}

/** A name IOS-XR takes for a policy, set, class or process: no spaces. */
export function xrName(value        , fallback        )         {
  const text = String(value ?? '').trim().replace(/\s+/g, '-');
  return text || fallback;
}

/** Lines of a textarea, trimmed, without blanks. */
export function lines(value        )           {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The note every change that could cut off the session it is applied from carries. */
export const COMMIT_CONFIRMED =
  'Pasting by hand: finish with `commit confirmed 300` (seconds) instead of `commit`, check the session and the verify commands, then `commit` again to keep it. If the session is lost it rolls itself back.';

/** How IOS-XR undoes a whole commit, which is often the cleanest back-out. */
export const ROLLBACK_NOTE =
  'IOS-XR keeps every commit: `show configuration commit list` shows them, and `rollback configuration last 1` undoes the most recent one whole.';

/** A 4-byte or 2-byte AS number, or asdot. */
export function validAsn(value        )          {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= 4294967295;
  }
  return /^\d{1,5}\.\d{1,5}$/.test(text);
}

export function asnFinding(value        , code        )            {
  return validAsn(value) ? [] : [warning(code, `"${value}" is not an AS number IOS-XR accepts (1-4294967295, or asdot).`, SRC)];
}

/**
 * A blueprint for IOS-XR, with its configuration tidied the way the file and
 * the merged build both need it:
 *
 * *  - no indented `!` lines: IOS-XR reads them as comments, and the full-configuration
 *    merge reads any `!` as the end of the top-level block, which would cut
 *    `router bgp` off at its first sub-mode;
 *  - `end-policy` and `end-set` indented one space, so the merge keeps them
 *    with the route-policy or prefix-set they close. IOS-XR ignores the
 *    indentation, and iosxr_config treats a column-0 `end-…` as a child of the
 *    block anyway.
 */
export function xrBlueprint(spec                                       )                  {
  return deviceBlueprint({ ...spec, change: (values                 , name        ) => tidy(spec.change(values, name)) });
}

function tidy(change              )               {
  return {
    ...change,
    config: change.config.filter((line) => !/^\s+!\s*$/.test(line)).map((line) => (/^end-(policy|set)$/.test(line) ? ` ${line}` : line)),
  };
}

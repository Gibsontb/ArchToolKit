/**
 * Dual stack for the cloud network blueprints, Terraform and Ansible alike.
 *
 * Every cloud here builds a network around an IPv4 range and adds IPv6 beside
 * it, so the blueprints keep their IPv4 fields as they were and ask one more
 * question — "Dual stack (IPv6)", off by default — plus, where the cloud does
 * not allocate the IPv6 range itself (Azure), the range to use. Rule sources
 * accept either family and are split by family, because a rule on most of
 * these platforms holds one family, and the "open to the world" check catches
 * ::/0 as well as 0.0.0.0/0.
 *
 * These read the page's values, so they turn every mistake into a finding
 * rather than an exception: a value that cannot work is an error, one that
 * works but is dangerous is a warning.
 */

import { error, warning,              } from '../../core/findings.js';
import { isAnyNetwork, parseCidrAny } from '../../core/ip.js';
import { bigToV6, compressIPv6, parseIPv6, v6ToBig } from '../../core/net-calc.js';
                                                             

/** A yes/no the page may hand over as a boolean or as the string "true". */
export const isOn = (value         )          =>
  value === true || String(value ?? '').trim().toLowerCase() === 'true';

/** The dual-stack question, off by default: IPv4 output is unchanged until it is asked for. */
export function dualStackInput(hint        , id = 'enable_ipv6')                 {
  return {
    id,
    label: 'Dual stack (IPv6)',
    control: 'select',
    options: [
      { value: 'false', label: 'No — IPv4 only' },
      { value: 'true', label: 'Yes — IPv4 and IPv6' },
    ],
    default: 'false',
    hint,
  };
}

/** Comma- or space-separated values, trimmed, empties dropped. */
export const listOf = (value         )           =>
  String(value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * A field that must be an IPv4 CIDR — a VPC, VNet or VCN range, which every
 * cloud requires even when the network is dual-stack.
 */
export function ipv4Range(value         , field        , what        , code        )            {
  const text = String(value ?? '').trim();
  const c = parseCidrAny(text);
  if (!c || !text.includes('/')) {
    return [error(`${code}.invalid-cidr`, `${what}: "${text}" is not a CIDR.`, { path: field })];
  }
  if (c.family === 6) {
    return [
      error(`${code}.ipv4-range-required`, `${what} must be an IPv4 range; "${text}" is IPv6.`, {
        path: field,
        remediation: 'Keep the IPv4 range here and turn on Dual stack (IPv6) for IPv6.',
      }),
    ];
  }
  return [];
}

/**
 * Rule sources of either family, split by family.
 *
 * Invalid entries are errors; the whole internet in either family is a
 * warning; IPv6 sources when the network has no IPv6 are a warning too,
 * because the rule can never match.
 */
export function sources(
  value         ,
  field        ,
  code        ,
  opts                                     = {},
)                                                      {
  const v4           = [];
  const v6           = [];
  const findings            = [];
  for (const item of listOf(value)) {
    const c = parseCidrAny(item);
    if (!c) {
      findings.push(error(`${code}.invalid-source`, `"${item}" is not an IPv4 or IPv6 address or CIDR.`, { path: field }));
      continue;
    }
    (c.family === 6 ? v6 : v4).push(item);
    if (isAnyNetwork(item)) {
      findings.push(
        warning(`${code}.open-to-world`, `${item} is the whole internet.`, {
          path: field,
          remediation: 'Narrow it to the networks that need access.',
        }),
      );
    }
  }
  if (v6.length > 0 && opts.ipv6Network === false) {
    findings.push(
      warning(`${code}.ipv6-source-without-ipv6`, `${v6.join(', ')} is IPv6, but the network is not dual-stack, so the rule can never match.`, {
        path: field,
        remediation: 'Turn on Dual stack (IPv6), or remove the IPv6 source.',
      }),
    );
  }
  return { v4, v6, findings };
}

/**
 * An IPv6 network written by hand (Azure), checked for size: `maxPrefix` is the
 * longest prefix allowed (64 for a VNet, exactly 64 for a subnet when `exact`).
 */
export function ipv6Range(
  value         ,
  field        ,
  what        ,
  code        ,
  opts                                                            = {},
)                                               {
  const text = String(value ?? '').trim();
  const c = parseCidrAny(text);
  if (!c || c.family !== 6 || !text.includes('/')) {
    return { cidr: null, findings: [error(`${code}.invalid-ipv6-cidr`, `${what}: "${text}" is not an IPv6 CIDR.`, { path: field })] };
  }
  const max = opts.maxPrefix ?? 64;
  if (opts.exact ? c.prefix !== max : c.prefix > max) {
    return {
      cidr: null,
      findings: [
        error(`${code}.ipv6-prefix`, `${what} must be ${opts.exact ? `a /${max}` : `/${max} or larger`}; "${text}" is a /${c.prefix}.`, {
          path: field,
        }),
      ],
    };
  }
  return { cidr: `${c.network}/${c.prefix}`, findings: [] };
}

/** The n-th /64 of an IPv6 network of /64 or larger, canonical. */
export function nthSlash64(network        , n        )         {
  const c = parseCidrAny(network);
  const value = v6ToBig(parseIPv6(c?.network ?? network.split('/')[0] ?? '') ?? []) + (BigInt(n) << 64n);
  return `${compressIPv6(bigToV6(value))}/64`;
}

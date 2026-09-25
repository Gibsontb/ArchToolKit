/**
 * What the Aruba AOS-CX blueprints share: port names, the checkpoint note,
 * address handling and the finding helpers.
 *
 * AOS-CX names a port member/slot/port (`1/1/49`), a split port with a colon
 * (`1/1/49:1`), and takes a range of them as `1/1/1-1/1/4`. The blueprints
 * expand a range into one block per port, so the complete configuration can
 * merge two steps that touch the same port.
 */

import { error, warning,              } from '../../core/findings.js';
import { listOf, netmask, parseCidrDual } from '../device.js';

export const PLATFORM = 'aruba_aoscx'         ;
export const SECRET = '<REQUIRED>';
export const SOURCE = 'ArchToolKit';

/** The AOS-CX safety net for a change that could cut off the session it is made from. */
export const CHECKPOINT =
  'Before pasting, run `checkpoint auto 5` from the manager prompt: if the session is lost the switch rolls back to the running configuration it had, after five minutes. Run `checkpoint auto confirm` once the checks pass.';

export const bad = (code        , message        , remediation         )          =>
  error(`network.aoscx.${code}`, message, { source: SOURCE, ...(remediation ? { remediation } : {}) });

export const warn = (code        , message        , remediation         )          =>
  warning(`network.aoscx.${code}`, message, { source: SOURCE, ...(remediation ? { remediation } : {}) });

const PORT = /^(\d+)\/(\d+)\/(\d+)(:\d+)?$/;
const RANGE = /^(\d+)\/(\d+)\/(\d+)-(?:(\d+)\/(\d+)\/)?(\d+)$/;

/** "1/1/1-1/1/4, 1/1/49" as the ports it names, and what could not be read. */
export function portList(value        )                                         {
  const ports           = [];
  const invalid           = [];
  for (const part of listOf(value)) {
    if (PORT.test(part)) {
      if (!ports.includes(part)) ports.push(part);
      continue;
    }
    const range = RANGE.exec(part);
    if (range) {
      const [member, slot, from] = [range[1], range[2], Number(range[3])];
      const sameSlot = range[4] === undefined || (range[4] === member && range[5] === slot);
      const to = Number(range[6]);
      if (sameSlot && to >= from && to - from < 64) {
        for (let p = from; p <= to; p += 1) {
          const name = `${member}/${slot}/${p}`;
          if (!ports.includes(name)) ports.push(name);
        }
        continue;
      }
    }
    invalid.push(part);
  }
  return { ports, invalid };
}

/** An error for every port name AOS-CX would not take. */
export function portFindings(what        , invalid                   )            {
  return invalid.map((p) =>
    bad('bad-port', `"${p}" in ${what} is not an AOS-CX port name.`, 'Write ports as member/slot/port: 1/1/1, a range as 1/1/1-1/1/8, a split port as 1/1/49:1.'),
  );
}

/**
 * Any interface AOS-CX names: a port, `vlan10`, `loopback0`, `lag1`, typed
 * without a space so a comma or space separated list stays one entry each.
 */
export function interfaceName(value        )                {
  const t = value.trim();
  if (PORT.test(t)) return t;
  const named = /^(vlan|loopback|lo|lag)\s*(\d+)$/i.exec(t);
  if (!named) return null;
  const kind = named[1] .toLowerCase();
  return `${kind === 'lo' ? 'loopback' : kind} ${named[2]}`;
}

export function interfaceList(value        )                                         {
  const names           = [];
  const invalid           = [];
  for (const part of listOf(value)) {
    const name = interfaceName(part);
    if (name === null) invalid.push(part);
    else if (!names.includes(name)) names.push(name);
  }
  return { names, invalid };
}

export function interfaceFindings(what        , invalid                   )            {
  return invalid.map((p) =>
    bad('bad-interface', `"${p}" in ${what} is not an AOS-CX interface name.`, 'Write a port as 1/1/49, and a logical interface without a space: vlan10, loopback0, lag1.'),
  );
}

/** An IPv4 prefix as AOS-CX access lists write it: 10.0.0.0/255.255.255.0. */
export function aclAddress(value        )                {
  const t = value.trim();
  if (t === 'any') return 'any';
  const c = parseCidrDual(t.includes('/') ? t : `${t}/32`);
  if (!c || c.family !== 4) return null;
  return c.prefix === 32 ? c.address : `${c.network}/${netmask(c.prefix)}`;
}

/** A dotted OSPF area from "0", "10" or "0.0.0.10". */
export function ospfArea(value        )                {
  const t = String(value ?? '').trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n > 0xffffffff) return null;
    return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.');
  }
  const parts = t.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return parts.map(Number).join('.');
  return null;
}

/** A route distinguisher or route target: ASN:nn or IPv4:nn. */
export const isRouteTag = (value        )          => /^(\d{1,10}|\d{1,3}(\.\d{1,3}){3}):\d{1,10}$/.test(value.trim());

/** A MAC written the AOS-CX way, xx:xx:xx:xx:xx:xx, and a unicast one. */
export function macFindings(code        , what        , value        )            {
  const t = value.trim();
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(t)) return [bad(code, `${what} "${t}" is not a MAC address written as xx:xx:xx:xx:xx:xx.`)];
  if (parseInt(t.slice(0, 2), 16) & 1) return [bad(code, `${what} ${t} is a multicast MAC: the first octet has to be even.`, 'Use a locally administered unicast MAC such as 02:00:00:00:01:00.')];
  return [];
}

/** VRF names AOS-CX keeps for itself. */
export const RESERVED_VRFS = ['default', 'mgmt'];

/** "10=USERS, 20=VOICE" as pairs, and what could not be read. */
export function pairs(value        )                                   {
  return listOf(value).map((entry) => {
    const [key = '', ...rest] = entry.split(/[=:]/);
    return { key: key.trim(), value: rest.join('=').trim() };
  });
}

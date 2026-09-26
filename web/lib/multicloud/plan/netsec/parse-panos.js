/**
 * PAN-OS `set` format into the netsec model.
 *
 * The same flat `set` lines the Network page writes and merges (full-config.ts
 * groups them as objects, NAT rules and security rules): `address`,
 * `address-group`, `service`, `service-group`, `rulebase security rules` and
 * `rulebase nat rules`. A rule may be one line carrying every attribute or one
 * line per attribute; both are read. Panorama's `device-group X pre-rulebase`,
 * `vsys vsysN` and `shared` prefixes are accepted.
 *
 * `service application-default` is resolved through the default ports of the
 * common App-IDs below; any other App-ID leaves the rule for review rather than
 * guessing its ports.
 */

import { info, warning,              } from '../../../core/findings.js';
import {
  ANY,
  finishRule,
  canonicalCidr,
  numberedLines,
  parseService,
  port,
  rangeToCidrs,
  tokens,
              
                 
               
                    
} from './model.js';

/** Default ports of common App-IDs (Palo Alto Applipedia), for `service application-default`. */
export const APP_DEFAULT_PORTS                                              = {
  ssl: ['tcp/443'],
  'web-browsing': ['tcp/80'],
  ssh: ['tcp/22'],
  dns: ['udp/53', 'tcp/53'],
  ldap: ['tcp/389', 'udp/389'],
  'ms-rdp': ['tcp/3389'],
  'mssql-db': ['tcp/1433'],
  oracle: ['tcp/1521'],
  mysql: ['tcp/3306'],
  postgres: ['tcp/5432'],
  smtp: ['tcp/25'],
  ntp: ['udp/123'],
  ping: ['icmp'],
  snmp: ['udp/161'],
  'ms-ds-smb': ['tcp/445'],
  kerberos: ['tcp/88', 'udp/88'],
};

const PREDEFINED_SERVICES                                                 = {
  'service-http': [{ protocol: 'tcp', from: 80, to: 80 }, { protocol: 'tcp', from: 8080, to: 8080 }],
  'service-https': [{ protocol: 'tcp', from: 443, to: 443 }],
};

                     
               
               
                               
 

/** The value at `at`: a `[ … ]` list or one token. */
function valueAt(t                   , at        )                                     {
  if (t[at] === '[') {
    const end = t.indexOf(']', at);
    const stop = end < 0 ? t.length : end;
    return { values: t.slice(at + 1, stop), used: stop - at + 1 };
  }
  return { values: t[at] !== undefined ? [t[at]          ] : [], used: 1 };
}

/** Drop the vsys / shared / device-group prefix: what is left starts after `set`. */
function body(t                   )           {
  let rest = t.slice(1);
  if (rest[0] === 'vsys' || rest[0] === 'device-group' || rest[0] === 'template') rest = rest.slice(2);
  else if (rest[0] === 'shared') rest = rest.slice(1);
  if (rest[0] === 'pre-rulebase' || rest[0] === 'post-rulebase') rest = ['rulebase', ...rest.slice(1)];
  return rest;
}

/** Nested attributes whose value is a phrase, not one token. */
const PHRASES = new Set(['source-translation', 'destination-translation', 'profile-setting', 'option', 'qos', 'target']);

export function parsePanos(text        , device = 'panos')               {
  const findings            = [];
  const addresses = new Map                  ();
  const services = new Map                     ();
  const security = new Map                   ();
  const nat = new Map                   ();

  const attach = (into                        , name        , line        , rest                   )       => {
    const draft = into.get(name) ?? { name, line, attrs: new Map                  () };
    into.set(name, draft);
    let i = 0;
    while (i < rest.length) {
      const key = rest[i]          ;
      if (PHRASES.has(key)) {
        // The rest of the line belongs to this attribute.
        draft.attrs.set(key, [...(draft.attrs.get(key) ?? []), ...rest.slice(i + 1)]);
        break;
      }
      const v = valueAt(rest, i + 1);
      draft.attrs.set(key, [...(draft.attrs.get(key) ?? []), ...v.values]);
      i += 1 + v.used;
    }
  };

  for (const { n, text: line } of numberedLines(text)) {
    const t = tokens(line.trim());
    if (t[0] !== 'set') continue;
    const b = body(t);
    if (b[0] === 'address' && b[1]) {
      const name = b[1];
      const kind = b[2];
      const v = b[3] ?? '';
      if (kind === 'ip-netmask') addresses.set(name, [canonicalCidr(v) ?? `?${v}`]);
      else if (kind === 'ip-range') {
        const [a = '', z = ''] = v.split('-');
        addresses.set(name, rangeToCidrs(a, z) ?? [`?${v}`]);
      } else if (kind === 'fqdn') addresses.set(name, [`fqdn:${v}`]);
    } else if (b[0] === 'address-group' && b[1] && b[2] === 'static') {
      addresses.set(b[1], valueAt(b, 3).values.map((m) => `@${m}`));
    } else if (b[0] === 'service' && b[1]) {
      const proto = b[b.indexOf('protocol') + 1];
      const portIdx = b.indexOf('port');
      const list = portIdx >= 0 ? (b[portIdx + 1] ?? '').split(',') : [];
      const out              = [];
      if (proto === 'tcp' || proto === 'udp') {
        for (const p of list) {
          const s = parseService(`${proto}/${p}`);
          if (s) out.push(s);
        }
      }
      if (out.length) services.set(b[1], [...(services.get(b[1]) ?? []), ...out]);
    } else if (b[0] === 'service-group' && b[1]) {
      const members = valueAt(b, b.indexOf('members') + 1).values;
      services.set(b[1], members.flatMap((m) => services.get(m) ?? PREDEFINED_SERVICES[m] ?? []));
    } else if (b[0] === 'rulebase' && b[2] === 'rules' && b[3]) {
      if (b[1] === 'security') attach(security, b[3], n, b.slice(4));
      else if (b[1] === 'nat') attach(nat, b[3], n, b.slice(4));
    }
  }

  // Groups hold names; resolve them once every object is known.
  const resolve = (name        , seen = new Set        ())           => {
    if (name === 'any') return [ANY];
    const direct = canonicalCidr(name);
    if (direct) return [direct];
    if (seen.has(name)) return [`?${name}`];
    seen.add(name);
    const entry = addresses.get(name);
    if (!entry) return [`?${name}`];
    return entry.flatMap((e) => (e.startsWith('@') ? resolve(e.slice(1), seen) : [e]));
  };

  const rules           = [];
  for (const draft of security.values()) {
    const a = draft.attrs;
    const unresolved           = [];
    const from = (a.get('source') ?? ['any']).flatMap((x) => resolve(x));
    const to = (a.get('destination') ?? ['any']).flatMap((x) => resolve(x));
    if (a.get('negate-source')?.[0] === 'yes') unresolved.push('negated source');
    if (a.get('negate-destination')?.[0] === 'yes') unresolved.push('negated destination');

    const serviceNames = a.get('service') ?? ['application-default'];
    let svc              = [];
    for (const s of serviceNames) {
      if (s === 'any') svc.push({ protocol: 'any' });
      else if (s === 'application-default') {
        const apps = a.get('application') ?? ['any'];
        if (apps.includes('any')) {
          svc.push({ protocol: 'any' });
          continue;
        }
        for (const app of apps) {
          const ports = APP_DEFAULT_PORTS[app];
          if (!ports) {
            unresolved.push(`app:${app}`);
            continue;
          }
          for (const p of ports) {
            const parsed = parseService(p);
            if (parsed) svc.push(parsed);
          }
        }
      } else {
        const known = services.get(s) ?? PREDEFINED_SERVICES[s];
        if (known) svc.push(...known);
        else unresolved.push(`service:${s}`);
      }
    }
    if (svc.length === 0 && unresolved.length === 0) svc = [{ protocol: 'any' }];
    const action = a.get('action')?.[0] ?? 'allow';
    rules.push({
      name: draft.name,
      from,
      to,
      services: svc,
      action: action === 'allow' ? 'allow' : 'deny',
      log: a.get('log-end')?.[0] !== 'no',
      disabled: a.get('disabled')?.[0] === 'yes',
      fromZone: a.get('from')?.join(' '),
      toZone: a.get('to')?.join(' '),
      source: { device, line: draft.line },
      ...(unresolved.length ? { unresolved } : {}),
    });
    for (const u of unresolved) {
      findings.push(info('netsec.panos.unresolved', `Rule ${draft.name}: ${u} is not resolved to addresses or ports, so the rule is listed for review.`, { path: `${device}:${draft.line}` }));
    }
  }

  const nats            = [];
  for (const draft of nat.values()) {
    const a = draft.attrs;
    const real = (a.get('source') ?? ['any']).flatMap((x) => resolve(x));
    const st = a.get('source-translation') ?? [];
    const dt = a.get('destination-translation') ?? [];
    const origin = { device, line: draft.line };
    if (dt.length) {
      const addr = dt[dt.indexOf('translated-address') + 1] ?? '';
      const tp = dt.indexOf('translated-port');
      const dst = (a.get('destination') ?? []).flatMap((x) => resolve(x));
      const svc = (a.get('service') ?? []).flatMap((s) => services.get(s) ?? PREDEFINED_SERVICES[s] ?? []);
      // The service is the outside port; translated-port, when set, is the inside one.
      const inside = tp >= 0 ? port(svc[0]?.protocol === 'udp' ? 'udp' : 'tcp', Number(dt[tp + 1])) : svc[0];
      nats.push({
        name: draft.name,
        kind: 'destination',
        real: resolve(addr),
        mapped: dst,
        ...(inside ? { service: inside } : {}),
        ...(tp >= 0 && svc[0]?.from !== undefined ? { mappedPort: svc[0].from } : {}),
        source: origin,
      });
    } else if (st.length) {
      const isStatic = st[0] === 'static-ip';
      const ta = st.indexOf('translated-address');
      const mapped = st.includes('interface-address') ? ['interface'] : ta >= 0 ? valueAt(st, ta + 1).values.flatMap((x) => resolve(x)) : [];
      nats.push({ name: draft.name, kind: isStatic ? 'static' : 'source', real, mapped, source: origin });
    } else {
      findings.push(warning('netsec.panos.nat', `NAT rule ${draft.name} has no translation the parser recognises.`, { path: `${device}:${draft.line}` }));
    }
  }

  return { device, platform: 'panos', rules: rules.map(finishRule), nats, vips: [], findings };
}

/**
 * F5 BIG-IP into the netsec model: virtual servers become `LbVip`s.
 *
 * Two inputs are read:
 *   - `bigip.conf` (tmsh): `ltm virtual`, `ltm pool`, `ltm node` and
 *     `ltm monitor`. IPv6 destinations are written `/Common/2001:db8::10.443`
 *     (a dot before the port), IPv4 ones `/Common/10.0.0.10:443`, and a route
 *     domain suffix (`%1`) is dropped;
 *   - an AS3 declaration (JSON), the format the Network page generates:
 *     `Service_HTTP` / `Service_HTTPS` / `Service_TCP` / `Service_UDP` /
 *     `Service_L4` with their `Pool` and `Monitor` objects. Where the
 *     declaration leaves persistence out, AS3's documented defaults apply
 *     (cookie for HTTP and HTTPS services, source address for the others).
 *
 * BIG-IP AFM firewall rules are not read; a data-centre exit moves the
 * application delivery, and the firewall rules come from the firewalls.
 */

import { warning,              } from '../../../core/findings.js';
import { familyOf, splitHostPort } from '../../../core/ip.js';
                                                                                                                 

/* ------------------------------------------------------------ tmsh reader --- */

                           
                                    
                                          
                        
 

/** Read tmsh `a b c { … }` structure into nodes. Quoted strings stay whole. */
export function readTmsh(text        )             {
                                                        
  const toks        = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    const re = /"((?:[^"\\]|\\.)*)"|([{}])|([^\s{}"]+)/g;
    let m                        ;
    while ((m = re.exec(line)) !== null) toks.push({ v: m[1] ?? m[2] ?? (m[3]          ), line: idx + 1 });
    toks.push({ nl: true });
  });
  let i = 0;
  const readList = ()             => {
    const out             = [];
    let words           = [];
    let line = 0;
    const flush = ()       => {
      if (words.length) out.push({ words, line });
      words = [];
    };
    while (i < toks.length) {
      const t = toks[i]       ;
      i += 1;
      if ('nl' in t) {
        flush();
        continue;
      }
      if (t.v === '}') {
        flush();
        return out;
      }
      if (t.v === '{') {
        const start = line || t.line;
        const header = words;
        words = [];
        out.push({ words: header, children: readList(), line: start });
        line = 0;
        continue;
      }
      if (words.length === 0) line = t.line;
      words.push(t.v);
    }
    flush();
    return out;
  };
  return readList();
}

/** `/Common/web_pool` → `web_pool`. */
const bare = (name        )         => name.replace(/^\/[^/]+\/(?:[^/]+\/)?/, '');

/** `/Common/10.0.0.10:443`, `/Common/2001:db8::10.443`, `10.0.0.10%1:443` → address and port. */
export function f5Destination(text        )                                           {
  const t = bare(text).replace(/%\d+/, '');
  const v6 = /^(.*:.*)\.(\d+|any)$/.exec(t);
  if (v6 && familyOf(v6[1]          ) === 6) return { address: v6[1]          , port: v6[2] === 'any' ? 0 : Number(v6[2]) };
  const hp = splitHostPort(t.replace(/:any$/, ':0'));
  if (hp.port === null || familyOf(hp.host) === null) return null;
  return { address: hp.host, port: hp.port };
}

const MONITOR_KINDS                                        = {
  http: 'http',
  https: 'https',
  http_head_f5: 'http',
  https_head_f5: 'https',
  tcp: 'tcp',
  tcp_half_open: 'tcp',
  gateway_icmp: 'icmp',
  icmp: 'icmp',
  udp: 'udp',
};

const child = (node          , key        )                       => node.children?.find((c) => c.words[0] === key);
const prop = (node          , key        )                     => {
  const c = child(node, key);
  return c && !c.children ? c.words[1] : undefined;
};

function persistenceOf(name                    )              {
  if (!name) return 'none';
  const n = bare(name);
  if (/cookie/.test(n)) return 'cookie';
  if (/source_addr|source-address|ssl|universal/.test(n)) return 'source-ip';
  return 'none';
}

export function parseBigipConf(text        , device = 'bigip')               {
  const findings            = [];
  const nodes = readTmsh(text);
  const nodeAddress = new Map                ();
  const monitors = new Map                                              ();
  const pools = new Map                                                                        ();

  for (const n of nodes) {
    if (n.words[0] === 'ltm' && n.words[1] === 'node' && n.words[2]) {
      const address = n.children ? prop(n, 'address') : undefined;
      if (address) nodeAddress.set(bare(n.words[2]), address.replace(/%\d+$/, ''));
    }
    if (n.words[0] === 'ltm' && n.words[1] === 'monitor' && n.words[2] && n.words[3]) {
      const from = n.children ? prop(n, 'defaults-from') : undefined;
      const kind = MONITOR_KINDS[n.words[2]] ?? MONITOR_KINDS[bare(from ?? '')] ?? 'tcp';
      const send = n.children ? prop(n, 'send') : undefined;
      const path = send ? /^(?:GET|HEAD)\s+(\S+)/.exec(send)?.[1] : undefined;
      monitors.set(bare(n.words[3]), { kind, ...(path ? { path } : {}) });
    }
  }
  for (const n of nodes) {
    if (!(n.words[0] === 'ltm' && n.words[1] === 'pool' && n.words[2])) continue;
    const members               = [];
    for (const m of child(n, 'members')?.children ?? []) {
      const key = bare(m.words[0] ?? '');
      const explicit = m.children ? prop(m, 'address') : undefined;
      const dest = f5Destination(key);
      const nameAndPort = /^(.+)[:.](\d+)$/.exec(key);
      const address = explicit?.replace(/%\d+$/, '') ?? dest?.address ?? (nameAndPort ? nodeAddress.get(nameAndPort[1]          ) : undefined);
      const port = dest?.port ?? (nameAndPort ? Number(nameAndPort[2]) : 0);
      if (address) members.push({ address, port });
      else findings.push(warning('netsec.f5.member', `Pool ${bare(n.words[2])}: member ${key} has no address the parser could find.`, { path: `${device}:${m.line}` }));
    }
    const monitorName = child(n, 'monitor')?.words[1];
    const own = monitorName ? monitors.get(bare(monitorName)) : undefined;
    pools.set(bare(n.words[2]), { members, monitor: own?.kind ?? (monitorName ? MONITOR_KINDS[bare(monitorName)] ?? 'tcp' : 'none'), ...(own?.path ? { path: own.path } : {}) });
  }

  const vips          = [];
  for (const n of nodes) {
    if (!(n.words[0] === 'ltm' && n.words[1] === 'virtual' && n.words[2])) continue;
    const name = bare(n.words[2]);
    const dest = f5Destination(prop(n, 'destination') ?? '');
    if (!dest) {
      findings.push(warning('netsec.f5.destination', `Virtual server ${name} has no destination the parser could read.`, { path: `${device}:${n.line}` }));
      continue;
    }
    const profiles = (child(n, 'profiles')?.children ?? []).map((p) => bare(p.words[0] ?? ''));
    const clientSsl = (child(n, 'profiles')?.children ?? []).some((p) => /clientssl/.test(p.words[0] ?? '') || p.children?.some((c) => c.words[0] === 'context' && c.words[1] === 'clientside'));
    const http = profiles.some((p) => /^http/.test(p) && !/compression|acceleration/.test(p));
    const ipProtocol = prop(n, 'ip-protocol') ?? 'tcp';
    const protocol              = http ? (clientSsl ? 'https' : 'http') : ipProtocol === 'udp' ? 'udp' : 'tcp';
    const tls         = clientSsl ? 'terminate' : dest.port === 443 && !http ? 'passthrough' : 'none';
    const pool = pools.get(bare(prop(n, 'pool') ?? ''));
    const persistNode = child(n, 'persist');
    vips.push({
      name,
      vip: dest.address,
      port: dest.port,
      protocol,
      pool: pool?.members ?? [],
      monitor: pool?.monitor ?? 'none',
      ...(pool?.path ? { monitorPath: pool.path } : {}),
      persistence: persistenceOf(persistNode?.children?.[0]?.words[0]),
      tls,
      source: { device, line: n.line },
    });
  }
  return { device, platform: 'f5', rules: [], nats: [], vips, findings };
}

/* -------------------------------------------------------------------- AS3 --- */

                                                                              
const isObj = (v                  )                             => typeof v === 'object' && v !== null && !Array.isArray(v);

const AS3_SERVICES                                                                                              = {
  Service_HTTP: { protocol: 'http', port: 80, persistence: 'cookie' },
  Service_HTTPS: { protocol: 'https', port: 443, persistence: 'cookie' },
  Service_TCP: { protocol: 'tcp', port: 0, persistence: 'source-ip' },
  Service_L4: { protocol: 'tcp', port: 0, persistence: 'source-ip' },
  Service_UDP: { protocol: 'udp', port: 0, persistence: 'source-ip' },
};

export function parseAs3(text        , device = 'as3')               {
  const findings            = [];
  let root      ;
  try {
    root = JSON.parse(text)        ;
  } catch (err) {
    return { device, platform: 'f5', rules: [], nats: [], vips: [], findings: [warning('netsec.f5.as3-json', `The AS3 declaration is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)] };
  }
  const decl = isObj(root) && isObj(root.declaration) ? root.declaration : root;
  const vips          = [];
  if (!isObj(decl)) return { device, platform: 'f5', rules: [], nats: [], vips, findings };

  for (const [, tenant] of Object.entries(decl)) {
    if (!isObj(tenant) || tenant.class !== 'Tenant') continue;
    for (const [, app] of Object.entries(tenant)) {
      if (!isObj(app) || app.class !== 'Application') continue;
      const ref = (v                  )                                    => {
        if (typeof v === 'string') return isObj(app[v]) ? (app[v]                         ) : undefined;
        if (isObj(v) && typeof v.use === 'string') {
          const last = v.use.split('/').pop()          ;
          return isObj(app[last]) ? (app[last]                         ) : undefined;
        }
        return undefined;
      };
      for (const [name, svc] of Object.entries(app)) {
        if (!isObj(svc) || typeof svc.class !== 'string' || !AS3_SERVICES[svc.class]) continue;
        const kind = AS3_SERVICES[svc.class]                                                                     ;
        const addresses = Array.isArray(svc.virtualAddresses) ? svc.virtualAddresses : [];
        const first = addresses[0];
        const vip = typeof first === 'string' ? first : Array.isArray(first) && typeof first[0] === 'string' ? first[0] : '';
        const pool = ref(svc.pool);
        const members               = [];
        for (const m of Array.isArray(pool?.members) ? pool.members : []) {
          if (!isObj(m)) continue;
          const port = typeof m.servicePort === 'number' ? m.servicePort : 0;
          for (const a of Array.isArray(m.serverAddresses) ? m.serverAddresses : []) if (typeof a === 'string') members.push({ address: a, port });
        }
        let monitor              = 'none';
        let monitorPath                    ;
        const mon = Array.isArray(pool?.monitors) ? pool.monitors[0] : undefined;
        if (typeof mon === 'string') monitor = MONITOR_KINDS[mon] ?? 'tcp';
        else if (mon !== undefined) {
          const obj = isObj(mon) && typeof mon.bigip === 'string' ? undefined : ref(mon);
          const type = typeof obj?.monitorType === 'string' ? obj.monitorType : isObj(mon) && typeof mon.bigip === 'string' ? bare(mon.bigip) : 'tcp';
          monitor = MONITOR_KINDS[type] ?? 'tcp';
          const send = typeof obj?.send === 'string' ? obj.send : undefined;
          monitorPath = send ? /^(?:GET|HEAD)\s+(\S+)/.exec(send)?.[1] : undefined;
        }
        const persistList = Array.isArray(svc.persistenceMethods) ? svc.persistenceMethods : undefined;
        const persistence              = persistList === undefined ? kind.persistence : persistList.length === 0 ? 'none' : persistenceOf(String(persistList[0]));
        const tls         = svc.serverTLS !== undefined ? 'terminate' : kind.protocol === 'https' ? 'terminate' : 'none';
        vips.push({
          name,
          vip,
          port: typeof svc.virtualPort === 'number' ? svc.virtualPort : kind.port,
          protocol: kind.protocol,
          pool: members,
          monitor,
          ...(monitorPath ? { monitorPath } : {}),
          persistence,
          tls,
          source: { device, line: 0 },
        });
      }
    }
  }
  return { device, platform: 'f5', rules: [], nats: [], vips, findings };
}

/** bigip.conf or an AS3 declaration, whichever the text is. */
export function parseF5(text        , device = 'f5')               {
  return text.trimStart().startsWith('{') ? parseAs3(text, device) : parseBigipConf(text, device);
}

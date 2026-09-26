/**
 * DNS zones from the data centre, as cloud private zones (addendum A.5.5,
 * Network: services).
 *
 * Read:
 *   - Infoblox WAPI JSON: `GET /wapi/v2.13.7/zone_auth` and `record:a`,
 *     `record:aaaa`, `record:cname` (either one object keyed by those names, or
 *     one array of objects whose `_ref` says what each is);
 *   - a Windows DNS zone file (`Export-DnsServerZone` writes RFC 1035 master
 *     file format) or any BIND zone file;
 *   - a CSV of `Get-DnsServerResourceRecord` (HostName, RecordType,
 *     RecordData, TimeToLive).
 * A, AAAA and CNAME records are carried; everything else is counted and left.
 *
 * Written, per platform, as Terraform: `aws_route53_zone` (private, with the
 * VPC) and `aws_route53_record`; `azurerm_private_dns_zone`, its virtual
 * network link and `azurerm_private_dns_a_record` / `_aaaa_record` /
 * `_cname_record`; `google_dns_managed_zone` (private) and
 * `google_dns_record_set`; `oci_dns_zone` (private view) and `oci_dns_rrset`.
 * VMware has no DNS service: the zone stays in the enterprise DNS.
 *
 * A re-IP map (old address → new) rewrites A and AAAA records on the way.
 */

import { parseCsvRecords, pick } from '../../../core/csv.js';
import { familyOf } from '../../../core/ip.js';
import { info, warning,              } from '../../../core/findings.js';
import { renderFile, str, num, raw, strings,               } from '../../../terraform/hcl.js';
                                            

                                             
                               
                                                
                        
                         
                       
                                     
 
                          
                        
                         
                                            
 
                            
                                     
                                        
 

const DEFAULT_TTL = 3600;
const noDot = (s        )         => s.trim().replace(/\.$/, '').toLowerCase();

/** `host.example.com` in zone `example.com` → `host`; the zone itself → `@`. */
export function relativeName(fqdn        , zone        )         {
  const f = noDot(fqdn);
  const z = noDot(zone);
  if (f === z) return '@';
  return f.endsWith(`.${z}`) ? f.slice(0, -(z.length + 1)) : f;
}

class ZoneBuilder {
           sets = new Map                                                                        ();
  add(name        , type         , value        , ttl        )       {
    const key = `${name}|${type}`;
    const set = this.sets.get(key) ?? { name, type, ttl, values: [] };
    if (!set.values.includes(value)) set.values.push(value);
    set.ttl = Math.min(set.ttl, ttl);
    this.sets.set(key, set);
  }
  records()                 {
    return [...this.sets.values()].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
  }
}

/* --------------------------------------------------------------- Infoblox --- */

                                   
const isObj = (v         )           => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseInfoblox(text        )            {
  const findings            = [];
  let root         ;
  try {
    root = JSON.parse(text);
  } catch (err) {
    return { zones: [], findings: [warning('dc.dns-json', `The Infoblox export is not JSON: ${err instanceof Error ? err.message : String(err)}`)] };
  }
  const byType = new Map               ();
  const push = (type        , o     )       => {
    byType.set(type, [...(byType.get(type) ?? []), o]);
  };
  if (Array.isArray(root)) {
    for (const o of root) if (isObj(o) && typeof o._ref === 'string') push(o._ref.split('/')[0]          , o);
  } else if (isObj(root)) {
    for (const [k, v] of Object.entries(root)) if (Array.isArray(v)) for (const o of v) if (isObj(o)) push(k, o);
  }
  const zones = new Map                                           ();
  for (const z of byType.get('zone_auth') ?? []) {
    if (typeof z.fqdn !== 'string') continue;
    zones.set(noDot(z.fqdn), { ...(typeof z.view === 'string' ? { view: z.view } : {}), b: new ZoneBuilder() });
  }
  const zoneOf = (o     , name        )                     => {
    if (typeof o.zone === 'string' && zones.has(noDot(o.zone))) return noDot(o.zone);
    return [...zones.keys()].filter((z) => name === z || name.endsWith(`.${z}`)).sort((a, b) => b.length - a.length)[0];
  };
  const add = (type         , field        )       => {
    for (const o of byType.get(`record:${type.toLowerCase()}`) ?? []) {
      const name = typeof o.name === 'string' ? noDot(o.name) : '';
      const value = o[field];
      if (!name || typeof value !== 'string') continue;
      const z = zoneOf(o, name);
      if (!z) {
        findings.push(info('dc.dns-no-zone', `Record ${name} is not in any exported zone_auth; add the zone to the export.`));
        continue;
      }
      const ttl = typeof o.ttl === 'number' ? o.ttl : DEFAULT_TTL;
      (zones.get(z)                      ).b.add(relativeName(name, z), type, type === 'CNAME' ? noDot(value) : value, ttl);
    }
  };
  add('A', 'ipv4addr');
  add('AAAA', 'ipv6addr');
  add('CNAME', 'canonical');
  return { zones: [...zones.entries()].map(([zone, { view, b }]) => ({ zone, ...(view ? { view } : {}), records: b.records() })), findings };
}

/* ------------------------------------------------------------- zone file --- */

/** A Windows (`Export-DnsServerZone`) or BIND zone file for one zone. */
export function parseZoneFile(text        , zone        )            {
  const findings            = [];
  const b = new ZoneBuilder();
  let origin = noDot(zone);
  let ttl = DEFAULT_TTL;
  let last = '@';
  let skipped = 0;
  // Join parenthesised continuations (the SOA) and drop comments.
  const joined           = [];
  let buf = '';
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '');
    depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    buf += ` ${line}`;
    if (depth <= 0) {
      joined.push(buf.replace(/^ /, ''));
      buf = '';
      depth = 0;
    }
  }
  for (const line of joined) {
    if (line.trim() === '') continue;
    const t = line.trim().split(/\s+/);
    if (t[0] === '$ORIGIN') {
      origin = noDot(t[1] ?? origin);
      continue;
    }
    if (t[0] === '$TTL') {
      ttl = Number(t[1]) || ttl;
      continue;
    }
    let i = 0;
    let owner = last;
    if (!/^\s/.test(line)) {
      owner = t[0]          ;
      i = 1;
    }
    last = owner;
    let rttl = ttl;
    while (i < t.length && (/^\d+$/.test(t[i]          ) || /^(IN|CH|HS)$/i.test(t[i]          ))) {
      if (/^\d+$/.test(t[i]          )) rttl = Number(t[i]);
      i += 1;
    }
    const type = (t[i] ?? '').toUpperCase();
    const data = t[i + 1] ?? '';
    const fqdn = owner === '@' ? origin : owner.endsWith('.') ? noDot(owner) : `${owner.toLowerCase()}.${origin}`;
    const name = relativeName(fqdn, zone);
    if (type === 'A' || type === 'AAAA') b.add(name, type, data, rttl);
    else if (type === 'CNAME') b.add(name, 'CNAME', data.endsWith('.') ? noDot(data) : `${data.toLowerCase()}.${origin}`, rttl);
    else if (type !== 'SOA' && type !== 'NS') skipped += 1;
  }
  if (skipped) findings.push(info('dc.dns-skipped', `${zone}: ${skipped} record(s) other than A, AAAA, CNAME, SOA and NS are left for review.`));
  return { zones: [{ zone: noDot(zone), records: b.records() }], findings };
}

/** A CSV of `Get-DnsServerResourceRecord` for one zone. */
export function parseDnsCsv(text        , zone        )            {
  const b = new ZoneBuilder();
  let skipped = 0;
  for (const row of parseCsvRecords(text)) {
    const host = (pick(row, 'HostName', 'Name') ?? '@').trim();
    const type = (pick(row, 'RecordType', 'Type') ?? '').toUpperCase();
    const data = (pick(row, 'RecordData', 'IPv4Address', 'IPv6Address', 'HostNameAlias', 'Data') ?? '').trim();
    const ttlText = pick(row, 'TimeToLive', 'TTL') ?? '';
    // TimeToLive exports as 01:00:00 (a TimeSpan) or as seconds.
    const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(ttlText);
    const ttl = hms ? Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) : Number(ttlText) || DEFAULT_TTL;
    const name = host === '@' ? '@' : relativeName(host.includes('.') && host.endsWith(zone) ? host : `${host}.${zone}`, zone);
    if (type === 'A' || type === 'AAAA') b.add(name, type, data, ttl);
    else if (type === 'CNAME') b.add(name, 'CNAME', noDot(data), ttl);
    else if (type) skipped += 1;
  }
  return { zones: [{ zone: noDot(zone), records: b.records() }], findings: skipped ? [info('dc.dns-skipped', `${zone}: ${skipped} record(s) other than A, AAAA and CNAME are left for review.`)] : [] };
}

/* -------------------------------------------------------------- re-IP map --- */

/** Rewrite A / AAAA values through a re-IP map (old → new); the map's family must match. */
export function applyReIp(zones                    , ipMap                             )                                                          {
  let changed = 0;
  const out = zones.map((z) => ({
    ...z,
    records: z.records.map((r) => {
      if (r.type === 'CNAME') return r;
      const values = r.values.map((v) => {
        const next = ipMap.get(v);
        if (next && familyOf(next) === familyOf(v)) {
          changed += 1;
          return next;
        }
        return v;
      });
      return { ...r, values };
    }),
  }));
  return { zones: out, changed };
}

/* -------------------------------------------------------------- Terraform --- */

const tfLabel = (...parts          )         => {
  const l = parts.join('_').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return /^[a-z_]/.test(l) ? l : `z_${l}`;
};
const fqdnOf = (r              , zone        )         => (r.name === '@' ? zone : `${r.name}.${zone}`);

function variable(name        , description        )           {
  return { type: 'variable', labels: [name], attributes: [{ name: 'description', value: str(description) }, { name: 'type', value: raw('string') }] };
}

/** Private zones and records for one platform, as HCL blocks. */
export function dnsBlocks(zones                    , platform          )                                                                                  {
  if (platform === 'vmware') {
    return { blocks: [], findings: [info('dc.dns-vmware', 'VCF has no authoritative DNS service: the zones stay in the enterprise DNS (Windows DNS or Infoblox), with the records switched at cutover.')] };
  }
  const blocks             = [];
  if (platform === 'aws') blocks.push(variable('vpc_id', 'The VPC the private zones are associated with.'));
  if (platform === 'azure') blocks.push(variable('resource_group_name', 'The resource group of the private DNS zones.'), variable('virtual_network_id', 'The virtual network the zones are linked to.'));
  if (platform === 'google') blocks.push(variable('network', 'The VPC network (self link) the private zones are visible to.'));
  if (platform === 'oci') blocks.push(variable('compartment_id', 'The compartment of the private zones.'), variable('view_id', 'The private view (of the VCN resolver) the zones belong to.'));
  for (const z of zones) {
    const zl = tfLabel(z.zone);
    if (platform === 'aws') {
      blocks.push({ type: 'resource', labels: ['aws_route53_zone', zl], attributes: [{ name: 'name', value: str(z.zone) }], blocks: [{ type: 'vpc', attributes: [{ name: 'vpc_id', value: raw('var.vpc_id') }] }] });
      for (const r of z.records) {
        blocks.push({
          type: 'resource',
          labels: ['aws_route53_record', tfLabel(z.zone, r.name === '@' ? 'apex' : r.name, r.type)],
          attributes: [
            { name: 'zone_id', value: raw(`aws_route53_zone.${zl}.zone_id`) },
            { name: 'name', value: str(fqdnOf(r, z.zone)) },
            { name: 'type', value: str(r.type) },
            { name: 'ttl', value: num(r.ttl) },
            { name: 'records', value: strings(r.values) },
          ],
        });
      }
    } else if (platform === 'azure') {
      blocks.push({ type: 'resource', labels: ['azurerm_private_dns_zone', zl], attributes: [{ name: 'name', value: str(z.zone) }, { name: 'resource_group_name', value: raw('var.resource_group_name') }] });
      blocks.push({
        type: 'resource',
        labels: ['azurerm_private_dns_zone_virtual_network_link', zl],
        attributes: [
          { name: 'name', value: str(`${z.zone}-link`) },
          { name: 'private_dns_zone_id', value: raw(`azurerm_private_dns_zone.${zl}.id`) },
          { name: 'virtual_network_id', value: raw('var.virtual_network_id') },
          { name: 'registration_enabled', value: raw('false') },
        ],
      });
      for (const r of z.records) {
        const type = r.type === 'A' ? 'azurerm_private_dns_a_record' : r.type === 'AAAA' ? 'azurerm_private_dns_aaaa_record' : 'azurerm_private_dns_cname_record';
        blocks.push({
          type: 'resource',
          labels: [type, tfLabel(z.zone, r.name === '@' ? 'apex' : r.name)],
          attributes: [
            { name: 'name', value: str(r.name) },
            { name: 'private_dns_zone_id', value: raw(`azurerm_private_dns_zone.${zl}.id`) },
            { name: 'ttl', value: num(r.ttl) },
            r.type === 'CNAME' ? { name: 'record', value: str(r.values[0] ?? '') } : { name: 'records', value: strings(r.values) },
          ],
        });
      }
    } else if (platform === 'google') {
      blocks.push({
        type: 'resource',
        labels: ['google_dns_managed_zone', zl],
        attributes: [{ name: 'name', value: str(zl.replace(/_/g, '-')) }, { name: 'dns_name', value: str(`${z.zone}.`) }, { name: 'visibility', value: str('private') }],
        blocks: [{ type: 'private_visibility_config', blocks: [{ type: 'networks', attributes: [{ name: 'network_url', value: raw('var.network') }] }] }],
      });
      for (const r of z.records) {
        blocks.push({
          type: 'resource',
          labels: ['google_dns_record_set', tfLabel(z.zone, r.name === '@' ? 'apex' : r.name, r.type)],
          attributes: [
            { name: 'managed_zone', value: raw(`google_dns_managed_zone.${zl}.name`) },
            { name: 'name', value: str(`${fqdnOf(r, z.zone)}.`) },
            { name: 'type', value: str(r.type) },
            { name: 'ttl', value: num(r.ttl) },
            { name: 'rrdatas', value: strings(r.type === 'CNAME' ? r.values.map((v) => `${v}.`) : r.values) },
          ],
        });
      }
    } else {
      blocks.push({
        type: 'resource',
        labels: ['oci_dns_zone', zl],
        attributes: [
          { name: 'compartment_id', value: raw('var.compartment_id') },
          { name: 'name', value: str(z.zone) },
          { name: 'zone_type', value: str('PRIMARY') },
          { name: 'scope', value: str('PRIVATE') },
          { name: 'view_id', value: raw('var.view_id') },
        ],
      });
      for (const r of z.records) {
        blocks.push({
          type: 'resource',
          labels: ['oci_dns_rrset', tfLabel(z.zone, r.name === '@' ? 'apex' : r.name, r.type)],
          attributes: [
            { name: 'zone_name_or_id', value: raw(`oci_dns_zone.${zl}.id`) },
            { name: 'domain', value: str(fqdnOf(r, z.zone)) },
            { name: 'rtype', value: str(r.type) },
            { name: 'view_id', value: raw('var.view_id') },
          ],
          blocks: r.values.map((v) => ({
            type: 'items',
            attributes: [
              { name: 'domain', value: str(fqdnOf(r, z.zone)) },
              { name: 'rtype', value: str(r.type) },
              { name: 'rdata', value: str(r.type === 'CNAME' ? `${v}.` : v) },
              { name: 'ttl', value: num(r.ttl) },
            ],
          })),
        });
      }
    }
  }
  return { blocks, findings: [] };
}

/** `dns/<platform>.tf` text. */
export function dnsTerraform(zones                    , platform          )                                                                   {
  const { blocks, findings } = dnsBlocks(zones, platform);
  return { text: blocks.length ? renderFile(blocks, 'Private DNS zones and records imported from the data-centre DNS.') : '', findings };
}

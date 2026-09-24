/**
 * The whole device configuration, assembled from the steps.
 *
 * The change list already gives you the steps in order, which is what a
 * brownfield change needs. It is not what a *build* needs. Standing up a new
 * switch, you do not want nine separate blocks that each re-enter
 * `interface Gi1/0/1` — you want one configuration, in the order a device
 * expects it, with each interface appearing once and everything it needs
 * gathered under it.
 *
 * So this merges. Blocks with the same header become one block, duplicate
 * lines inside them are dropped, and the result is laid out in the order the
 * platform's own running configuration uses: system and management first, then
 * VLANs, then interfaces, then spanning tree, then routing, then policy.
 *
 * The four platform families each need their own treatment, because their
 * configuration is not the same kind of thing:
 *
 *   - IOS, NX-OS and EOS: indented CLI blocks, merged by header;
 *   - PAN-OS: flat `set` lines, deduplicated and grouped by what they touch;
 *   - FortiOS: `config … end` sections with `edit … next` entries inside,
 *     merged by section path;
 *   - F5: AS3 declarations, merged into one declaration per tenant, which is
 *     the only honest way to combine them — AS3 replaces a tenant wholesale,
 *     so two declarations for one tenant posted in turn would each delete the
 *     other's application.
 */

import { info, warning,              } from '../core/findings.js';
import { deviceFile, PLATFORMS,                                  } from './device.js';

                                 
                         
                                
 

                             
                        
                                        
 

/* -------------------------------------------------------------------------- *
 * CLI platforms: IOS, NX-OS, EOS
 * -------------------------------------------------------------------------- */

                 
                          
                          
 

/**
 * Split configuration lines into top-level blocks and their indented bodies.
 *
 * A banner is the exception to the indentation rule: its text is not indented
 * and runs until the delimiter appears again, so it is absorbed whole rather
 * than read as a series of commands.
 */
export function blocksOf(lines                   )          {
  const blocks          = [];
  let current                                            = null;
  let bannerDelimiter                = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (bannerDelimiter !== null) {
      current?.body.push(line);
      if (line.includes(bannerDelimiter)) {
        bannerDelimiter = null;
        current = null;
      }
      continue;
    }

    if (line.trim() === '' || line.trim() === '!') {
      current = null;
      continue;
    }
    if (/^\s/.test(line)) {
      if (current) current.body.push(` ${line.trim()}`);
      else blocks.push({ header: line.trim(), body: [] });
      continue;
    }

    current = { header: line.trim(), body: [] };
    blocks.push(current);

    const banner = /^banner\s+\S+\s+(\S)/.exec(line.trim());
    if (banner) bannerDelimiter = banner[1]          ;
  }
  return blocks;
}

/** The section a block belongs in, and the order sections are written. */
const CLI_SECTIONS                                                                                     = [
  { id: 'system', title: 'System and features', match: /^(hostname|ip domain|feature |no feature|service |no service |clock |boot |version |username |aaa |enable |crypto )/ },
  { id: 'management', title: 'Management: time, logging, SNMP, access', match: /^(ntp |logging |snmp-server|line |banner|management |ip ssh|ip http|no ip http|telnet)/ },
  { id: 'vlans', title: 'VLANs', match: /^vlan /i },
  { id: 'vrf', title: 'VRFs', match: /^(vrf |ip vrf )/ },
  { id: 'portchannels', title: 'Port-channels and bundles', match: /^interface (Port-channel|port-channel|Port-Channel)/i },
  { id: 'svis', title: 'Routed interfaces (SVIs and loopbacks)', match: /^interface (Vlan|loopback|Loopback)/i },
  { id: 'interfaces', title: 'Physical interfaces', match: /^interface /i },
  { id: 'stp', title: 'Spanning tree', match: /^(spanning-tree|no spanning-tree)/ },
  { id: 'policy', title: 'Access lists and prefix lists', match: /^(ip access-list|ipv6 access-list|access-list|ip prefix-list|route-map|class-map|policy-map)/ },
  { id: 'routing', title: 'Routing', match: /^(router |ip route|ipv6 route|ip routing|service routing)/ },
  { id: 'other', title: 'Everything else', match: /.*/ },
];

function sectionOf(header        )         {
  return (CLI_SECTIONS.find((section) => section.match.test(header)) ?? CLI_SECTIONS[CLI_SECTIONS.length - 1] ).id;
}

function mergeCli(platform          , steps                           )                                                        {
  const findings            = [];
  const merged = new Map                                                            ();
  const order           = [];

  for (const step of steps) {
    for (const block of blocksOf(step.change.config)) {
      const key = block.header.toLowerCase();
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { header: block.header, body: [...block.body], from: [step.label] });
        order.push(key);
        continue;
      }
      // The same interface, VLAN or process configured by two steps: one block,
      // with the lines the second adds appended and the repeats dropped.
      const seen = new Set(existing.body.map((line) => line.trim()));
      for (const line of block.body) {
        if (seen.has(line.trim())) continue;
        seen.add(line.trim());
        existing.body.push(line);
      }
      if (!existing.from.includes(step.label)) existing.from.push(step.label);
    }
  }

  for (const entry of merged.values()) {
    if (entry.from.length > 1) {
      findings.push(
        info('network.full.merged', `"${entry.header}" is configured by ${entry.from.length} steps (${entry.from.join(', ')}); the full configuration has it once, with everything they set.`, {
          source: 'ArchToolKit',
        }),
      );
    }
  }

  const bySection = new Map                 ();
  for (const key of order) {
    const entry = merged.get(key) ;
    const section = sectionOf(entry.header);
    const list = bySection.get(section) ?? [];
    list.push({ header: entry.header, body: entry.body });
    bySection.set(section, list);
  }

  void platform;
  return { blocks: bySection, findings };
}

/* -------------------------------------------------------------------------- *
 * PAN-OS: flat set commands
 * -------------------------------------------------------------------------- */

const PANOS_GROUPS                                                                = [
  { title: 'Network: interfaces, zones, virtual routers', match: /\b(network interface|zone |network virtual-router)/ },
  { title: 'Objects: addresses, groups, services', match: /\b(address |address-group |service |service-group |tag )/ },
  { title: 'NAT rules', match: /\bnat rules\b/ },
  { title: 'Security rules', match: /\bsecurity rules\b/ },
  { title: 'Everything else', match: /.*/ },
];

/* -------------------------------------------------------------------------- *
 * FortiOS: config … end sections
 * -------------------------------------------------------------------------- */

                        
                        
                             
 

/** Split FortiOS configuration into its `config <path> … end` sections. */
export function fortiSections(lines                   )                 {
  const out                 = [];
  let current                                             = null;
  let depth = 0;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (/^config /.test(trimmed) && depth === 0) {
      current = { path: trimmed.replace(/^config\s+/, ''), entries: [] };
      out.push(current);
      depth = 1;
      continue;
    }
    if (trimmed === 'end' && depth === 1) {
      depth = 0;
      current = null;
      continue;
    }
    if (current) current.entries.push(line);
  }
  return out;
}

const FORTI_ORDER = ['system', 'router', 'firewall address', 'firewall addrgrp', 'firewall service', 'firewall vip', 'firewall policy'];

function fortiRank(path        )         {
  const index = FORTI_ORDER.findIndex((prefix) => path.startsWith(prefix));
  return index < 0 ? FORTI_ORDER.length : index;
}

/* -------------------------------------------------------------------------- *
 * F5: one AS3 declaration
 * -------------------------------------------------------------------------- */

function isRecord(value         )                                   {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge AS3 declarations into one, tenant by tenant. */
function mergeAs3(steps                           , name        )             {
  const findings            = [];
  const tenants                                          = {};
  let schemaVersion = '3.45.0';
  let schema = 'https://raw.githubusercontent.com/F5Networks/f5-appsvcs-extension/main/schema/latest/as3-schema.json';

  for (const step of steps) {
    let parsed         ;
    try {
      parsed = JSON.parse(step.change.config.join('\n'));
    } catch (err) {
      findings.push(warning('network.full.bad-declaration', `"${step.label}" is not readable as a declaration, so it was left out of the combined one: ${(err         ).message}`, { source: 'ArchToolKit' }));
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed['declaration'])) continue;
    const adc = parsed['declaration'];
    if (typeof adc['schemaVersion'] === 'string') schemaVersion = adc['schemaVersion'];
    if (typeof parsed['$schema'] === 'string') schema = parsed['$schema'];

    for (const [key, value] of Object.entries(adc)) {
      if (!isRecord(value) || value['class'] !== 'Tenant') continue;
      const tenant = (tenants[key] ??= { class: 'Tenant' });
      for (const [appName, app] of Object.entries(value)) {
        if (appName === 'class') continue;
        if (tenant[appName] !== undefined) {
          findings.push(
            warning('network.full.duplicate-application', `Two steps define the application ${key}/${appName}. The later one wins in the combined declaration.`, {
              remediation: 'Give them different application names, or keep them in separate declarations.',
              source: 'ArchToolKit',
            }),
          );
        }
        tenant[appName] = app;
      }
    }
  }

  const tenantNames = Object.keys(tenants);
  if (tenantNames.length === 0) {
    return { text: '', findings };
  }

  findings.push(
    info('network.full.as3-combined', `One declaration for ${tenantNames.length} tenant(s): ${tenantNames.join(', ')}. AS3 replaces a tenant wholesale, so applications in the same tenant have to be posted together.`, {
      source: 'ArchToolKit',
    }),
  );

  const declaration = {
    $schema: schema,
    class: 'AS3',
    action: 'deploy',
    persist: true,
    declaration: {
      class: 'ADC',
      schemaVersion,
      id: `vcf-${name}`,
      label: name,
      remark: ' the whole change as one declaration. Review before deploying.',
      ...tenants,
    },
  };

  return { text: `${JSON.stringify(declaration, null, 2)}\n`, findings };
}

/* -------------------------------------------------------------------------- *
 * The entry point
 * -------------------------------------------------------------------------- */

/** Things a complete device configuration normally has, and a nudge when it does not. */
function completeness(platform          , steps                           )            {
  if (platform === 'f5' || platform === 'panos' || platform === 'fortios') return [];
  const all = steps.flatMap((step) => step.change.config).join('\n');
  const out            = [];
  if (!/^hostname /m.test(all)) {
    out.push(
      info('network.full.no-hostname', 'This configuration has no hostname, NTP, logging or SNMP: it is a set of changes rather than a complete build.', {
        remediation: 'Add the management baseline for this platform if you are building a device from scratch.',
        source: 'ArchToolKit',
      }),
    );
  }
  if (!/^spanning-tree/m.test(all) && /^interface /m.test(all)) {
    out.push(
      info('network.full.no-stp', 'No spanning-tree configuration is included. A switch build should set its mode, its root priority and its edge-port protections.', {
        source: 'ArchToolKit',
      }),
    );
  }
  return out;
}

/**
 * The steps for one platform, assembled into one configuration.
 *
 * Returns empty text when there is nothing to write, which the caller takes as
 * "do not emit a file".
 */
export function fullConfig(platform          , steps                           , name = 'network build')             {
  const mine = steps.filter((step) => step.change.platform === platform);
  if (mine.length === 0) return { text: '', findings: [] };

  const platformInfo = PLATFORMS[platform];
  const comment = platformInfo.comment;
  const findings            = [];

  const header = [
    `${comment} ${name} — complete ${platformInfo.label} configuration`,
    `${comment} from ${mine.length} step(s): ${mine.map((s) => s.label).join(', ')}.`,
    `${comment}`,
    `${comment} This is the whole configuration, merged and in order — not the change`,
    `${comment} steps. Each interface, VLAN and process appears once, with everything`,
    `${comment} the steps set on it. Diff it against the running configuration before`,
    `${comment} you use it, and save afterwards with: ${platformInfo.save}`,
    `${comment}`,
    `${comment} The per-step files carry what to capture first, what to verify and how`,
    `${comment} to back each step out. This file does not: it is the destination, not`,
    `${comment} the journey.`,
    '',
  ];

  if (platform === 'f5') {
    const merged = mergeAs3(mine, name);
    return { text: merged.text ? deviceFile(platform, merged.text) : merged.text, findings: [...merged.findings] };
  }

  if (platform === 'panos') {
    const seen = new Set        ();
    const grouped = PANOS_GROUPS.map((group) => ({ title: group.title, lines: []             }));
    for (const step of mine) {
      for (const line of step.change.config) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        const index = PANOS_GROUPS.findIndex((group) => group.match.test(trimmed));
        grouped[index < 0 ? PANOS_GROUPS.length - 1 : index] .lines.push(trimmed);
      }
    }
    const body = grouped.flatMap((group) => (group.lines.length === 0 ? [] : [`${comment} --- ${group.title} ---`, ...group.lines, '']));
    findings.push(
      info('network.full.panos-order', 'Written in the order PAN-OS needs: interfaces and zones, then objects, then NAT, then security rules. Nothing takes effect until the commit at the end.', {
        source: 'ArchToolKit',
      }),
    );
    return { text: deviceFile(platform, `${[...header, ...body, `${comment} --- commit ---`, `commit description "${name}"`].join('\n').trimEnd()}\n`), findings };
  }

  if (platform === 'fortios') {
    const sections = new Map                  ();
    for (const step of mine) {
      for (const section of fortiSections(step.change.config)) {
        const existing = sections.get(section.path) ?? [];
        const seen = new Set(existing.map((line) => line.trim()));
        for (const entry of section.entries) {
          if (entry.trim() !== 'next' && seen.has(entry.trim())) continue;
          existing.push(entry);
        }
        sections.set(section.path, existing);
      }
    }
    const ordered = [...sections.entries()].sort((a, b) => fortiRank(a[0]) - fortiRank(b[0]) || a[0].localeCompare(b[0]));
    const body = ordered.flatMap(([path, entries]) => [`${comment} --- ${path} ---`, `config ${path}`, ...entries, 'end', '']);
    findings.push(
      info('network.full.fortios-order', 'Sections are merged and ordered: system, routing, addresses, then policies. FortiOS applies each section as its `end` is entered.', { source: 'ArchToolKit' }),
    );
    return { text: deviceFile(platform, `${[...header, ...body].join('\n').trimEnd()}\n`), findings };
  }

  // IOS, NX-OS and EOS.
  const { blocks, findings: mergeFindings } = mergeCli(platform, mine);
  findings.push(...mergeFindings, ...completeness(platform, mine));

  const body           = [];
  for (const section of CLI_SECTIONS) {
    const list = blocks.get(section.id);
    if (!list || list.length === 0) continue;
    body.push(`${comment} ${'='.repeat(4)} ${section.title} ${'='.repeat(Math.max(4, 60 - section.title.length))}`, comment);
    for (const block of list) {
      // A block with a body gets a separator after it, the way a running
      // configuration reads. Single commands run together, because a `!`
      // between every one of forty lines is noise.
      if (block.body.length === 0) {
        body.push(block.header);
        continue;
      }
      if (body[body.length - 1] !== comment) body.push(comment);
      body.push(block.header, ...block.body, comment);
    }
    body.push('');
  }

  return { text: deviceFile(platform, `${[...header, ...body].join('\n').trimEnd()}\n`), findings };
}

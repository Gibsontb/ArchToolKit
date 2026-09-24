/**
 * A network change: the configuration, how to check it, and how to undo it.
 *
 * A Terraform plan can be read before it runs and a playbook has `--check`.
 * A router does not: the moment a line is pasted, it is live, and a wrong
 * access list or a VLAN missing from a trunk takes a site off the network with
 * no undo. So nothing here emits configuration on its own. Every blueprint
 * produces four things together, and the file carries all four:
 *
 *   1. what to capture *before* the change, so there is something to compare to;
 *   2. the configuration itself;
 *   3. what to run *after* to prove it worked;
 *   4. the back-out — the exact commands that put it back.
 *
 * That is also what a change record needs, which is the other half of why it
 * is generated rather than written by hand at 2am.
 *
 * The same change can be applied two ways: pasted into a session, or pushed by
 * Ansible. Both come out of one structure, so they cannot disagree.
 */

                                                   
import { info, warning } from '../core/findings.js';

                                                                                                                          

                               
                        
                         
                                                          
                          
                                                      
                           
                                               
                              
                                                              
                              
                                                  
                        
                                                    
                             
     
                                                                              
                                                                      
                                                                              
                                                                            
                                                                             
                                            
     
                                     
 

export const PLATFORMS                                           = {
  cisco_ios: {
    id: 'cisco_ios',
    label: 'Cisco IOS / IOS-XE',
    device: 'switch or router',
    comment: '!',
    collection: 'cisco.ios',
    networkOs: 'cisco.ios.ios',
    save: 'write memory',
    extension: '.cfg',
    commentsAccepted: true,
  },
  cisco_nxos: {
    id: 'cisco_nxos',
    label: 'Cisco NX-OS',
    device: 'Nexus switch',
    comment: '!',
    collection: 'cisco.nxos',
    networkOs: 'cisco.nxos.nxos',
    save: 'copy running-config startup-config',
    extension: '.cfg',
    commentsAccepted: true,
  },
  cisco_wlc: {
    id: 'cisco_wlc',
    label: 'Cisco Catalyst 9800 (wireless)',
    device: 'wireless LAN controller',
    comment: '!',
    // The 9800 is IOS-XE, so the IOS collection drives it.
    collection: 'cisco.ios',
    networkOs: 'cisco.ios.ios',
    save: 'write memory',
    extension: '.cfg',
    commentsAccepted: true,
  },
  cisco_asa: {
    id: 'cisco_asa',
    label: 'Cisco ASA (firewall)',
    device: 'firewall',
    comment: '!',
    collection: 'cisco.asa',
    networkOs: 'cisco.asa.asa',
    save: 'write memory',
    extension: '.cfg',
    commentsAccepted: true,
  },
  arista_eos: {
    id: 'arista_eos',
    label: 'Arista EOS',
    device: 'switch',
    comment: '!',
    collection: 'arista.eos',
    networkOs: 'arista.eos.eos',
    save: 'write memory',
    extension: '.cfg',
    commentsAccepted: true,
  },
  panos: {
    id: 'panos',
    label: 'Palo Alto PAN-OS',
    device: 'firewall or Panorama',
    comment: '#',
    collection: 'paloaltonetworks.panos',
    save: 'commit',
    extension: '.txt',
    commentsAccepted: false,
  },
  fortios: {
    id: 'fortios',
    label: 'Fortinet FortiOS',
    device: 'FortiGate',
    comment: '#',
    collection: 'fortinet.fortios',
    save: 'the change applies as each `end` is entered; back it up with `execute backup config`',
    extension: '.txt',
    commentsAccepted: false,
  },
  f5: {
    id: 'f5',
    label: 'F5 BIG-IP (AS3)',
    device: 'BIG-IP',
    comment: '//',
    collection: 'f5networks.f5_modules',
    save: 'the declaration is the configuration; save with `tmsh save sys config` after it applies',
    extension: '.json',
    commentsAccepted: false,
  },
};

/** How risky a change is to the traffic already flowing through the device. */
                    
                                                                                 
          
                                                                                     
           
                                                                                       
             

export const IMPACT_MEANING                                   = {
  none: 'No effect on traffic already flowing: this adds configuration that nothing is using yet.',
  brief: 'Traffic can move or drop for a moment while this converges. Do it in a window unless the path is redundant and proven.',
  outage: 'Something stops passing traffic until this is complete. This needs a change window and someone watching.',
};

/** How Ansible would apply the same change. */
                       
                                                             
                          
                                                   
                                                                           
                                                                                                                                   
                                                                   
                          
 

                               
                              
                                                                    
                         
                          
                                                  
                                     
                                                              
                                     
                                          
                                     
                                             
                                      
                                                                              
                                     
                       
                                         
 

const rule = (comment        , text        )         => `${comment} ${'-'.repeat(2)} ${text} ${'-'.repeat(Math.max(2, 68 - text.length))}`;

function section(comment        , heading        , lines                   , prefix = '')           {
  if (lines.length === 0) return [];
  return [rule(comment, heading), ...lines.map((line) => (prefix && line.trim() !== '' ? `${prefix}${line}` : line)), ''];
}

/**
 * The change as one file: the header, what to capture first, the configuration,
 * the checks and the back-out.
 *
 * The parts that are not configuration are commented out in the device's own
 * comment syntax, so the whole file can be pasted into a session and only the
 * configuration takes effect. That is how it will be used whatever anyone
 * intends: someone will select all and paste.
 */
/**
 * A change whose configuration carries remarks (`! Then attach the profile…`)
 * on a platform that has no comment syntax: the remarks move to the notes, so
 * the file is configuration only and the record still says them.
 */
export function withRemarksAsNotes(change              )               {
  if (PLATFORMS[change.platform].commentsAccepted || change.platform === 'f5') return change;
  const remark = (line        ) => /^\s*(!|#)/.test(line);
  const remarks = change.config.filter(remark);
  if (remarks.length === 0) return change;
  return {
    ...change,
    config: change.config.filter((line) => !remark(line)),
    notes: [...(change.notes ?? []), ...remarks.map((line) => line.trim().replace(/^(!|#)\s*/, ''))],
  };
}

export function renderChange(original              , name        )         {
  const change = withRemarksAsNotes(original);
  const platform = PLATFORMS[change.platform];
  const c = platform.comment;
  const lines           = [
    `${c} ${change.title}`,
    `${c} ${platform.label}`,
    `${c}`,
    `${c} Impact: ${IMPACT_MEANING[change.impact]}`,
    `${c} Save:   ${platform.save}`,
    `${c}`,
    `${c} Everything outside the configuration block is commented out, so this file`,
    `${c} can be pasted whole. Read it first: it is a draft for review, not a`,
    `${c} change that has been approved for your network.`,
    '',
  ];

  if (change.notes && change.notes.length > 0) {
    lines.push(...section(c, 'before you start', change.notes.map((n) => `${c} ${n}`)));
  }
  lines.push(...section(c, 'capture first', change.before.map((cmd) => `${c}   ${cmd}`)));
  lines.push(...section(c, `configuration — ${name || 'change'}`, change.config));
  lines.push(...section(c, 'verify', change.verify.map((cmd) => `${c}   ${cmd}`)));
  lines.push(...section(c, 'back out', change.backout.map((cmd) => `${c}   ${cmd}`)));

  return deviceFile(change.platform, `${lines.join('\n').trimEnd()}\n`);
}

function configOnly(text        , comment        )         {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith(comment))
    .join('\n')
    .trim();
}

function isJson(text        )          {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The name a change's file is written under: the platform's extension, except
 * for an F5 change that is a command rather than a declaration, which is a
 * shell script and named like one.
 */
export function changeFileName(change              , base        )         {
  const info_ = PLATFORMS[change.platform];
  if (change.platform === 'f5' && !isJson(change.config.join('\n'))) return `${base}.sh`;
  return `${base}${info_.extension}`;
}

/** Typographic characters a device CLI may reject or mangle, and their ASCII. */
const ASCII                                   = {
  '\u2014': '-', '\u2013': '-', '\u2012': '-', '\u2010': '-', '\u2011': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"',
  '\u2026': '...', '\u00D7': 'x', '\u2192': '->', '\u2190': '<-', '\u2264': '<=', '\u2265': '>=', '\u00A0': ' ',
};

/** A CLI line in plain ASCII, so a terminal or TFTP load takes it byte for byte. */
export function asciiOnly(text        )         {
  return text.replace(/[^\x00-\x7F]/g, (ch) => ASCII[ch] ?? '?');
}

/**
 * The file as the device takes it.
 *
 * For a platform whose loader skips comment lines, the file is kept whole —
 * notes, checks and back-out commented out — so it can be pasted as it stands.
 * For one that does not, every comment line is dropped and only configuration
 * is left: a PAN-OS `set` list, a FortiOS `config … end` script, an AS3
 * declaration that parses as JSON. CLI files are made plain ASCII.
 */
export function deviceFile(platform          , text        )         {
  const info_ = PLATFORMS[platform];
  let out = text;
  if (platform === 'f5' && !isJson(configOnly(text, info_.comment))) {
    // Not a declaration: a tmsh or REST command. It is a shell script, then,
    // run on the BIG-IP (tmsh) or a workstation (curl); `#` is its comment.
    const body = configOnly(text, info_.comment).replace(/^#!.*\n/, '');
    return `#!/bin/sh\n# Run on the BIG-IP (tmsh) or a host that reaches its management address (curl).\nset -eu\n\n${asciiOnly(body).trimEnd()}\n`;
  }
  if (!info_.commentsAccepted) {
    out = out
      .split('\n')
      .filter((line) => !line.trim().startsWith(info_.comment))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '');
  }
  if (platform !== 'f5') out = asciiOnly(out);
  return `${out.trimEnd()}\n`;
}

/**
 * How the generated file is loaded on the device, in the device's own terms.
 *
 * IOS / NX-OS / EOS / ASA / 9800: paste in configuration mode, or copy the file
 * to running-config (comment lines are ignored either way). PAN-OS: paste the
 * `set` commands in configure mode, then commit (docs.paloaltonetworks.com,
 * "Load Configuration Settings from a Text File"). FortiOS: paste the
 * `config … end` blocks into the CLI. F5: POST the AS3 declaration to
 * /mgmt/shared/appsvcs/declare (clouddocs.f5.com, AS3 API reference).
 */
export function applySteps(change              , file        )           {
  switch (change.platform) {
    case 'cisco_ios':
    case 'cisco_wlc':
    case 'cisco_asa':
      return [
        `Paste \`${file}\` after \`configure terminal\`, then \`end\` and \`${PLATFORMS[change.platform].save}\`; the \`!\` lines are comments and are ignored.`,
        `Or load it: \`copy scp://<user>@<host>/${file} running-config\` (${change.platform === 'cisco_asa' ? 'ASA: `copy disk0:/' + file + ' running-config` after copying it to flash' : 'or tftp:/ftp:/flash:'}).`,
      ];
    case 'cisco_nxos':
      return [
        `Paste \`${file}\` after \`configure terminal\`, then \`end\` and \`copy running-config startup-config\`.`,
        `Or load it: copy the file to bootflash: and run \`copy bootflash:${file} running-config\`.`,
      ];
    case 'arista_eos':
      return [
        `Paste \`${file}\` after \`configure terminal\` (or \`configure session\` to review with \`show session-config diffs\` before \`commit\`), then \`write memory\`.`,
        `Or load it: \`copy flash:${file} running-config\` after copying it to flash.`,
      ];
    case 'panos':
      return [
        `From operational mode: \`set cli scripting-mode on\` (more than ~20 lines will not paste otherwise), \`configure\`, paste \`${file}\`, check with \`show | compare\`, then \`commit\`.`,
        'The file is `set` commands only: PAN-OS has no comment syntax, so the notes are here rather than in the file.',
      ];
    case 'fortios':
      return [
        `Paste \`${file}\` into the CLI (each \`config … end\` block applies when its \`end\` is entered), or run it as a configuration script from the GUI.`,
        'The file is configuration only; the notes are here rather than in the file.',
      ];
    case 'f5':
      return file.endsWith('.json')
        ? [
            `POST the declaration: \`curl -sku <user> -H 'Content-Type: application/json' -X POST https://<bigip>/mgmt/shared/appsvcs/declare -d @${file}\` (AS3 must be installed).`,
            'AS3 replaces the whole tenant: merge this into the current declaration for the tenant first.',
          ]
        : [`Run \`${file}\` on the BIG-IP (tmsh) or a host that reaches its management address (curl).`];
    default:
      return [];
  }
}

/** The change record: the same four parts, as text for a ticket. */
export function renderRecord(original              , name        , file         )           {
  const change = withRemarksAsNotes(original);
  const platform = PLATFORMS[change.platform];
  const apply = file ? applySteps(change, file) : [];
  return [
    `### ${name || change.title}`,
    '',
    `**What:** ${change.title}  `,
    `**Where:** ${platform.label} (${platform.device})  `,
    `**Impact:** ${IMPACT_MEANING[change.impact]}`,
    '',
    ...(change.notes && change.notes.length > 0 ? ['**Before you start**', '', ...change.notes.map((n) => `- ${n}`), ''] : []),
    '**Capture first**',
    '',
    ...change.before.map((cmd) => `- \`${cmd}\``),
    '',
    ...(apply.length > 0 ? ['**Apply**', '', ...apply.map((line) => `- ${line}`), ''] : []),
    '**Verify**',
    '',
    ...change.verify.map((cmd) => `- \`${cmd}\``),
    '',
    '**Back out**',
    '',
    '```',
    ...change.backout,
    '```',
    '',
  ];
}

/** Findings every change gets, on top of whatever the blueprint found. */
export function standingFindings(change              )            {
  const out            = [];
  if (change.backout.length === 0) {
    out.push(
      warning('network.change.no-backout', 'This change has no back-out written, so put one in the change record before it is applied.', {
        source: 'ArchToolKit',
      }),
    );
  }
  if (change.impact !== 'none') {
    out.push(
      warning('network.change.impact', IMPACT_MEANING[change.impact], {
        remediation: 'Confirm the window and that the path is redundant before applying it.',
        source: 'ArchToolKit',
      }),
    );
  }
  out.push(
    info('network.change.review', 'Configuration is generated from the answers on this page. Diff it against the running configuration before you paste it.', {
      source: 'ArchToolKit',
    }),
  );
  return out;
}

/* -------------------------------------------------------------------------- *
 * Small syntax helpers the blueprints share
 * -------------------------------------------------------------------------- */

/** A list typed as "1,2,5-8" or "Gi1/0/1, Gi1/0/2", cleaned up. */
export function listOf(value        )           {
  return String(value ?? '')
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** VLAN ids from "10,20,30-32", in order, deduplicated, 1–4094 only. */
export function vlanIds(value        )           {
  const out = new Set        ();
  for (const part of listOf(value)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) if (i >= 1 && i <= 4094) out.add(i);
      continue;
    }
    const one = Number(part);
    if (Number.isInteger(one) && one >= 1 && one <= 4094) out.add(one);
  }
  return [...out].sort((a, b) => a - b);
}

/** "10,20,30-32" back from a list of ids, collapsing runs. */
export function vlanRange(ids                   )         {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const parts           = [];
  let start                = null;
  let previous                = null;
  const flush = () => {
    if (start === null || previous === null) return;
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
  };
  for (const id of sorted) {
    if (start === null) {
      start = id;
      previous = id;
      continue;
    }
    if (previous !== null && id === previous + 1) {
      previous = id;
      continue;
    }
    flush();
    start = id;
    previous = id;
  }
  flush();
  return parts.join(',');
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(value        )          {
  const match = IPV4.exec(String(value ?? '').trim());
  if (!match) return false;
  return match.slice(1).every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255 && String(n) === String(Number(octet));
  });
}

/** "10.0.0.0/24" split into address and prefix length. */
export function parseCidr(value        )                                             {
  const [address, prefix] = String(value ?? '').trim().split('/');
  if (!address || !isIpv4(address)) return null;
  const length = Number(prefix);
  if (!Number.isInteger(length) || length < 0 || length > 32) return null;
  return { address, prefix: length };
}

/** A prefix length as the dotted mask IOS and PAN-OS want in places. */
export function netmask(prefix        )         {
  const bits = Math.max(0, Math.min(32, Math.trunc(prefix)));
  const value = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/** The wildcard mask IOS access lists and OSPF network statements want. */
export function wildcard(prefix        )         {
  return netmask(prefix)
    .split('.')
    .map((octet) => 255 - Number(octet))
    .join('.');
}

/** A description safe to put on an interface: no control characters, bounded. */
export function description(value        , fallback        )         {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  return (text || fallback).slice(0, 200);
}

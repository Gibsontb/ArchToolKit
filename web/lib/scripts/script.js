/**
 * The script model.
 *
 * A script is not a configuration file and it is not a playbook. It runs once,
 * on someone's machine, usually with more privilege than the person realises,
 * and usually at the moment something is already going wrong. So the contract
 * here is the one that matters for that: what it needs before it will run, the
 * script itself, how to see what it would do without doing it, and how to undo
 * it — or an honest statement that it cannot be undone.
 *
 * That last part is why this is worth generating rather than writing from a
 * blank file each time. A script written in a hurry has no dry run, no error
 * handling, a credential in line 4, and no idea what it did when it stops half
 * way through. Every script here starts with the opposite of that.
 */

import { info, warning,              } from '../core/findings.js';

                                                                      

                                     
                              
                         
                                 
                             
                                                         
                           
                                                    
                            
                             
                           
                                                                   
                              
                                                         
                         
 

export const SCRIPT_PLATFORMS                                                       = {
  powershell: {
    id: 'powershell',
    label: 'PowerShell',
    extension: '.ps1',
    comment: '#',
    runWith: 'pwsh -File',
    dryRunFlag: '-WhatIf',
    lint: 'Invoke-ScriptAnalyzer -Path <file> -Severity Warning,Error',
  },
  python: {
    id: 'python',
    label: 'Python',
    extension: '.py',
    comment: '#',
    shebang: '#!/usr/bin/env python3',
    runWith: 'python3',
    dryRunFlag: '--dry-run',
    lint: 'python3 -m py_compile <file>',
  },
  bash: {
    id: 'bash',
    label: 'Bash (Linux and macOS)',
    extension: '.sh',
    comment: '#',
    shebang: '#!/usr/bin/env bash',
    runWith: 'bash',
    dryRunFlag: '--dry-run',
    lint: 'bash -n <file>   # and shellcheck <file>, if it is installed',
  },
  cmd: {
    id: 'cmd',
    label: 'Windows batch (cmd)',
    extension: '.cmd',
    comment: 'REM',
    runWith: 'cmd /c',
    dryRunFlag: '/WHATIF',
  },
};

/** What running this does to whatever it touches. */
                          
                                                             
          
                                                      
                
                                                            
                   
                                                         
                  

export const EFFECT_MEANING                                         = {
  read: 'Reads and reports. It changes nothing, so it is safe to run whenever.',
  idempotent: 'Changes things, and is safe to run again — a second run finds the work already done and leaves it alone.',
  'repeat-unsafe': 'Changes things, and a second run does the work a second time. Run it once, and check before re-running.',
  destructive: 'Deletes, overwrites or disables something. Run the dry run first, read what it lists, and make sure a backup exists.',
};

/** What the script needs before it will run. */
                                    
                                                 
                        
                                                
                        
 

/** One parameter the generated script takes on its own command line. */
                                  
                        
                               
                             
                            
 

                         
                                    
                                 
                         
                                
                                                                             
                                                  
                                                                
                                                  
                           
                                   
                                       
                                    
                                                    
                                   
                                                    
                                     
                                         
 

const ruleWidth = 74;

function rule(comment        , heading        )         {
  const text = ` ${heading} `;
  const dashes = Math.max(3, ruleWidth - comment.length - text.length - 3);
  return `${comment} ---${text}${'-'.repeat(dashes)}`;
}

/** Wrap prose so a comment block does not run off the side of an editor. */
function wrap(text        , width = ruleWidth - 4)           {
  const words = text.split(/\s+/).filter(Boolean);
  const lines           = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/**
 * The script as a file.
 *
 * The header is a comment block in the platform's own syntax, so the whole file
 * runs as written. Everything a person needs in order to decide whether to run
 * it is in that header: what it does, what it needs, how to make it report
 * rather than act, and how to undo it. Putting that in a separate document is
 * how it gets separated from the script and then lost.
 */
export function renderScript(script        , name        )         {
  const platform = SCRIPT_PLATFORMS[script.platform];
  const c = platform.comment;
  const lines           = [];

  if (platform.shebang) lines.push(platform.shebang);
  lines.push(`${c} ${script.title}`);
  lines.push(`${c}`);
  for (const line of wrap(EFFECT_MEANING[script.effect])) lines.push(`${c} ${line}`);
  lines.push(`${c}`);
  lines.push(`${c} Generated by ArchToolKit. Read it before you run it.`);
  lines.push(`${c}`);

  if (script.requires.length > 0) {
    lines.push(rule(c, 'Needs'));
    for (const requirement of script.requires) {
      lines.push(`${c}   ${requirement.what}`);
      if (requirement.how) lines.push(`${c}     ${requirement.how}`);
    }
    lines.push(`${c}`);
  }

  if (script.parameters.length > 0) {
    lines.push(rule(c, 'Parameters'));
    for (const parameter of script.parameters) {
      lines.push(`${c}   ${parameter.name}${parameter.required ? '  (required)' : ''}`);
      for (const line of wrap(parameter.description, ruleWidth - 8)) lines.push(`${c}     ${line}`);
      if (parameter.example) lines.push(`${c}     e.g. ${parameter.example}`);
    }
    lines.push(`${c}`);
  }

  lines.push(rule(c, 'Running it'));
  for (const line of script.usage) lines.push(`${c}   ${line}`);
  lines.push(`${c}`);

  lines.push(rule(c, 'Undoing it'));
  for (const line of script.undo) lines.push(`${c}   ${line}`);
  lines.push(`${c}`);

  if (script.notes && script.notes.length > 0) {
    lines.push(rule(c, 'Before you run it'));
    for (const note of script.notes) {
      const [first, ...rest] = wrap(note, ruleWidth - 6);
      lines.push(`${c}   - ${first ?? ''}`);
      for (const line of rest) lines.push(`${c}     ${line}`);
    }
    lines.push(`${c}`);
  }

  lines.push(`${c} ${'='.repeat(ruleWidth - c.length - 1)}`);
  lines.push('');
  lines.push(...script.body);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** The README that travels with the script, for the ticket or the repository. */
export function renderReadme(script        , name        )           {
  const platform = SCRIPT_PLATFORMS[script.platform];
  const file = `${name || 'script'}${platform.extension}`;
  return [
    `# ${script.title}`,
    '',
    `**Platform:** ${platform.label}  `,
    `**Effect:** ${EFFECT_MEANING[script.effect]}`,
    '',
    ...(script.notes && script.notes.length > 0 ? ['## Before you run it', '', ...script.notes.map((n) => `- ${n}`), ''] : []),
    '## What it needs',
    '',
    ...(script.requires.length > 0
      ? script.requires.flatMap((r) => [`- ${r.what}`, ...(r.how ? [`  - \`${r.how}\``] : [])])
      : ['- Nothing beyond the interpreter itself.']),
    '',
    ...(script.parameters.length > 0
      ? [
          '## Parameters',
          '',
          '| Name | Required | What it is |',
          '| --- | --- | --- |',
          ...script.parameters.map((p) => `| \`${p.name}\` | ${p.required ? 'yes' : 'no'} | ${p.description} |`),
          '',
        ]
      : []),
    '## Running it',
    '',
    '```',
    ...script.usage,
    '```',
    '',
    '## Undoing it',
    '',
    ...script.undo.map((line) => `- ${line}`),
    '',
    '## Checking it before it runs',
    '',
    ...(platform.lint ? ['```', platform.lint.replace('<file>', file), '```', ''] : ['Nothing checks a batch file but reading it.', '']),
    '---',
    '',
    'Generated by ArchToolKit. No credential is written into a generated file — the script prompts, or reads one from the platform’s own secret store.',
  ];
}

/**
 * The checks that apply to every script, whatever it does.
 *
 * A credential in a script outlives the reason it was put there: it ends up in
 * a repository, in a ticket, in a screenshot. And a script that changes things
 * without a dry run is one that gets run against production by someone who
 * meant to test it.
 */
export function standingFindings(script        )            {
  const findings            = [];
  const platform = SCRIPT_PLATFORMS[script.platform];

  const suspicious = /(password|passwd|secret|api[_-]?key|token|credential|connectionstring)\s*[:=]\s*["']?[^"'\s<$({]/i;
  for (const line of script.body) {
    if (line.trim().startsWith(platform.comment)) continue;
    if (suspicious.test(line)) {
      findings.push(
        warning('scripts.credential-literal', 'A line in this script looks like it assigns a credential directly. Nothing generated here should: the script prompts, or reads one from a secret store.', {
          remediation: 'Replace it with a prompt or a lookup before this file goes anywhere.',
          source: 'ArchToolKit',
        }),
      );
      break;
    }
  }

  if (script.effect !== 'read') {
    const hasDryRun = script.body.some((line) => line.includes(platform.dryRunFlag) || /WhatIf|DryRun|dry_run|DRY_RUN/i.test(line));
    if (!hasDryRun) {
      findings.push(
        warning('scripts.no-dry-run', 'This script changes things and has no way to report what it would do instead. That is the difference between finding a mistake in a list and finding it in production.', {
          remediation: `Add a ${platform.dryRunFlag} path before running it anywhere that matters.`,
          source: 'ArchToolKit',
        }),
      );
    }
  }

  if (script.effect === 'destructive') {
    findings.push(
      warning('scripts.destructive', 'This script deletes, overwrites or disables something. Run the dry run, read every line of what it lists, and confirm a backup exists and has been restored from at least once.', {
        source: 'ArchToolKit',
      }),
    );
  }

  if (script.effect === 'repeat-unsafe') {
    findings.push(
      info('scripts.repeat-unsafe', 'Running this twice does the work twice. If it stops half way through, read what it did before running it again.', { source: 'ArchToolKit' }),
    );
  }

  return findings;
}

// --- small helpers the blueprints share ------------------------------------

/** A comma or newline separated list, cleaned up. */
export function listOf(value        )           {
  return String(value ?? '')
    .split(/[,\n]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** A name safe to use as a file name, a function name or a variable. */
export function identifier(value        , fallback        )         {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/** PascalCase, for a PowerShell function or a .NET-shaped name. */
export function pascal(value        , fallback        )         {
  const parts = identifier(value, fallback).split('-').filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('') || fallback;
}

/** snake_case, for Python and shell. */
export function snake(value        , fallback        )         {
  return identifier(value, fallback).toLowerCase().replace(/-/g, '_');
}

/** A single-quoted string for a shell or PowerShell literal, escaped. */
export function quoted(value        )         {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/** A Python string literal, escaped. */
export function pyString(value        )         {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

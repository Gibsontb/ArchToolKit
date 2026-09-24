/**
 * Which language a file is: from its name, then its shebang, then its content.
 *
 * Kept apart from languages.ts (which loads CodeMirror) so the rules are unit
 * tested under node. Network configs get real attention here because they
 * rarely have a telling extension: "core-sw1.txt" is a Cisco config and
 * "props.conf" is Splunk, and only the content says so.
 */

export interface LanguageInfo {
  readonly id: string;
  readonly label: string;
  /** Lower-case extensions without the dot. */
  readonly ext?: readonly string[];
  /** Whole file names, lower-case (Dockerfile, Makefile). */
  readonly names?: readonly string[];
}

export const LANGUAGES: readonly LanguageInfo[] = [
  { id: 'text', label: 'Normal Text', ext: ['txt', 'text'] },
  { id: 'asn1', label: 'ASN.1', ext: ['asn', 'asn1', 'mib'] },
  { id: 'c', label: 'C', ext: ['c', 'h'] },
  { id: 'cpp', label: 'C++', ext: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'] },
  { id: 'csharp', label: 'C#', ext: ['cs', 'csx'] },
  { id: 'cisco', label: 'Cisco IOS / NX-OS / EOS config', ext: ['ios', 'cisco', 'nxos', 'eos', 'iosxe', 'iosxr', 'asa'] },
  { id: 'cmake', label: 'CMake', ext: ['cmake'], names: ['cmakelists.txt'] },
  { id: 'cobol', label: 'COBOL', ext: ['cob', 'cbl', 'cpy'] },
  { id: 'css', label: 'CSS', ext: ['css', 'scss', 'less'] },
  { id: 'diff', label: 'Diff', ext: ['diff', 'patch'] },
  { id: 'dockerfile', label: 'Dockerfile', ext: ['dockerfile'], names: ['dockerfile', 'containerfile'] },
  { id: 'erlang', label: 'Erlang', ext: ['erl', 'hrl'] },
  { id: 'fortran', label: 'Fortran', ext: ['f', 'for', 'f90', 'f95', 'f03'] },
  { id: 'go', label: 'Go', ext: ['go'] },
  { id: 'groovy', label: 'Groovy', ext: ['groovy', 'gradle', 'gvy'], names: ['jenkinsfile'] },
  { id: 'html', label: 'HTML', ext: ['html', 'htm', 'xhtml', 'vue', 'svelte'] },
  { id: 'http', label: 'HTTP', ext: ['http'] },
  { id: 'ini', label: 'INI / Splunk .conf', ext: ['ini', 'conf', 'cfg', 'inf', 'reg', 'meta', 'desktop', 'editorconfig', 'gitconfig'], names: ['.gitconfig', '.editorconfig'] },
  { id: 'java', label: 'Java', ext: ['java'] },
  { id: 'javascript', label: 'JavaScript', ext: ['js', 'mjs', 'cjs', 'jsx'] },
  { id: 'json', label: 'JSON', ext: ['json', 'jsonc', 'json5', 'geojson', 'har', 'ipynb', 'tfstate'] },
  { id: 'junos', label: 'Junos config', ext: ['junos', 'jcfg'] },
  { id: 'kotlin', label: 'Kotlin', ext: ['kt', 'kts'] },
  { id: 'log', label: 'Log file', ext: ['log', 'out', 'err'] },
  { id: 'lua', label: 'Lua', ext: ['lua'] },
  { id: 'markdown', label: 'Markdown', ext: ['md', 'markdown', 'mdown', 'mkd'] },
  { id: 'nginx', label: 'nginx', ext: ['nginx'], names: ['nginx.conf'] },
  { id: 'pascal', label: 'Pascal', ext: ['pas', 'pp', 'dpr'] },
  { id: 'perl', label: 'Perl', ext: ['pl', 'pm', 't'] },
  { id: 'php', label: 'PHP', ext: ['php', 'phtml'] },
  { id: 'powershell', label: 'PowerShell', ext: ['ps1', 'psm1', 'psd1'] },
  { id: 'properties', label: 'Properties', ext: ['properties'] },
  { id: 'protobuf', label: 'Protocol Buffers', ext: ['proto'] },
  { id: 'puppet', label: 'Puppet', ext: ['pp'] },
  { id: 'python', label: 'Python', ext: ['py', 'pyw', 'pyi'], names: ['sconstruct', 'sconscript'] },
  { id: 'r', label: 'R', ext: ['r', 'rmd'] },
  { id: 'ruby', label: 'Ruby', ext: ['rb', 'gemspec', 'rake'], names: ['gemfile', 'rakefile', 'vagrantfile'] },
  { id: 'rust', label: 'Rust', ext: ['rs'] },
  { id: 'scala', label: 'Scala', ext: ['scala', 'sc'] },
  { id: 'shell', label: 'Shell (bash)', ext: ['sh', 'bash', 'zsh', 'ksh', 'bashrc', 'profile'], names: ['.bashrc', '.profile', '.zshrc', 'makefile'] },
  { id: 'sql', label: 'SQL', ext: ['sql', 'ddl', 'dml'] },
  { id: 'swift', label: 'Swift', ext: ['swift'] },
  { id: 'tcl', label: 'Tcl', ext: ['tcl', 'tk'] },
  { id: 'hcl', label: 'Terraform / HCL', ext: ['tf', 'tfvars', 'hcl', 'nomad'] },
  { id: 'toml', label: 'TOML', ext: ['toml'] },
  { id: 'typescript', label: 'TypeScript', ext: ['ts', 'mts', 'cts', 'tsx'] },
  { id: 'vb', label: 'Visual Basic', ext: ['vb', 'bas', 'cls', 'frm'] },
  { id: 'vbscript', label: 'VBScript', ext: ['vbs'] },
  { id: 'verilog', label: 'Verilog', ext: ['v', 'sv', 'svh'] },
  { id: 'vhdl', label: 'VHDL', ext: ['vhd', 'vhdl'] },
  { id: 'xml', label: 'XML', ext: ['xml', 'xsd', 'xsl', 'xslt', 'svg', 'plist', 'csproj', 'vbproj', 'props', 'targets', 'config', 'resx', 'wsdl', 'nuspec', 'xaml'] },
  { id: 'yaml', label: 'YAML', ext: ['yaml', 'yml'] },
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

export function languageLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

function extensionOf(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : dot === 0 ? base.slice(1) : '';
}

function byFileName(name: string): string | null {
  const base = (name.toLowerCase().split(/[\\/]/).pop() ?? '').trim();
  if (!base) return null;
  for (const l of LANGUAGES) if (l.names?.includes(base)) return l.id;
  if (/^dockerfile[.-]/.test(base)) return 'dockerfile';
  return null;
}

function byExtension(name: string): string | null {
  const ext = extensionOf(name);
  if (!ext) return null;
  // Extensions the content must settle.
  if (ext === 'conf' || ext === 'cfg' || ext === 'txt' || ext === 'pp') return null;
  for (const l of LANGUAGES) if (l.ext?.includes(ext)) return l.id;
  return null;
}

function byShebang(first: string): string | null {
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(first);
  if (!m) return null;
  const prog = (m[1]!.endsWith('/env') ? m[2] ?? '' : m[1]!).split('/').pop()!.toLowerCase();
  if (/^(ba|z|k|da)?sh$/.test(prog)) return 'shell';
  if (prog.startsWith('python')) return 'python';
  if (prog === 'node' || prog === 'deno' || prog === 'bun') return 'javascript';
  if (prog === 'pwsh' || prog === 'powershell') return 'powershell';
  if (prog.startsWith('perl')) return 'perl';
  if (prog.startsWith('ruby')) return 'ruby';
  if (prog === 'lua') return 'lua';
  if (prog === 'tclsh' || prog === 'wish') return 'tcl';
  if (prog === 'rscript') return 'r';
  return null;
}

/** Lines of a network device config that give the platform away. */
const CISCO_HINTS: readonly RegExp[] = [
  /^hostname \S+$/m,
  /^interface (?:[A-Za-z-]+\d|Vlan\d|Loopback\d|Port-channel\d|port-channel\d|mgmt\d|Ethernet\d|Management\d)/m,
  /^!\s*$/m,
  /^version \d+\.\d+/m,
  /^router (?:ospf|bgp|eigrp|isis|rip)\b/m,
  /^ ip address \d+\.\d+\.\d+\.\d+ \d+\.\d+\.\d+\.\d+/m,
  /^ switchport /m,
  /^feature \S+$/m,
  /^line (?:vty|con|console) /m,
  /^ip route \d/m,
  /^(?:no )?service \S+/m,
  /^end$/m,
];

const JUNOS_HINTS: readonly RegExp[] = [
  /^set (?:system|interfaces|protocols|routing-options|policy-options|firewall|security|vlans|snmp) /m,
  /^(?:system|interfaces|protocols|routing-options|policy-options|firewall|security|chassis|vlans) \{\s*$/m,
  /^\s+(?:host-name|family inet6?|unit \d+) /m,
  /^## Last (?:changed|commit):/m,
  /^version \d+\.\d+[A-Z]\d/m,
];

const LOG_LINE =
  /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}|\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}|\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}|\d{10}(?:\.\d+)? |\S+ - - \[\d{2}\/[A-Z][a-z]{2}\/\d{4}:|<\d{1,3}>)/;

function count(res: readonly RegExp[], text: string): number {
  return res.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

/** Guess from the text alone. `null` when nothing is convincing. */
export function detectFromContent(text: string, name = ''): string | null {
  const sample = text.slice(0, 64 * 1024);
  const trimmed = sample.replace(/^﻿/, '').trimStart();
  if (!trimmed) return null;

  const shebang = byShebang(trimmed.split('\n', 1)[0]!);
  if (shebang) return shebang;

  if (/^<\?xml\b/.test(trimmed)) return 'xml';
  if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) return 'html';
  if (/^<\?php/.test(trimmed)) return 'php';
  if (/^[{[]/.test(trimmed)) {
    try {
      JSON.parse(sample);
      return 'json';
    } catch {
      // Not strict JSON; carry on (Junos braces and HCL also start with "{" rarely).
    }
  }
  if (/^(?:diff --git |--- \S.*\n\+\+\+ \S|Index: \S)/m.test(trimmed.slice(0, 2000))) return 'diff';

  // A "display set" dump is all set lines, which one hint alone would undercount.
  const setLines = (sample.match(/^set \S+ \S/gm) ?? []).length;
  const junos = count(JUNOS_HINTS, sample) + (setLines >= 2 ? 1 : 0);
  if (junos >= 2) return 'junos';
  const cisco = count(CISCO_HINTS, sample);
  if (cisco >= 3) return 'cisco';

  if (/^\s*(?:resource|data|module|variable|output|provider|terraform)\s+("[^"]*"\s*)*\{/m.test(sample)) return 'hcl';

  const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 200);
  const logLines = lines.filter((l) => LOG_LINE.test(l)).length;
  if (lines.length >= 2 && logLines / lines.length >= 0.6) return 'log';

  const stanzas = lines.filter((l) => /^\s*\[[^\]\n]+\]\s*$/.test(l)).length;
  const pairs = lines.filter((l) => /^\s*[\w.:$<>/-][\w .:$<>/-]*?\s*=\s*/.test(l)).length;
  if (/^\s*(?:server|http|events|upstream|location)\s*[^{;]*\{/m.test(sample) && /;\s*$/m.test(sample)) return 'nginx';
  if (stanzas >= 1 && pairs >= 1) return 'ini';

  if (/^---\s*$/m.test(trimmed.slice(0, 200)) || (lines.length >= 3 && lines.filter((l) => /^\s*(?:- )?[\w.-]+:(?:\s|$)/.test(l)).length / lines.length > 0.6))
    return 'yaml';
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b[\s\S]*;/i.test(trimmed.slice(0, 4000)) && /\b(?:FROM|INTO|TABLE|SET|VALUES)\b/i.test(sample))
    return 'sql';
  if (/^(?:\$\w+\s*=|param\s*\(|function \w+-\w+|Get-|Set-|New-|Write-Host)/m.test(sample)) return 'powershell';
  if (/^#{1,6} \S/m.test(trimmed) && /(?:^\s*[-*] \S|\[[^\]]+\]\([^)]+\)|^```)/m.test(sample)) return 'markdown';

  if (name && /\.(?:conf|cfg)$/i.test(name) && pairs >= 1) return 'ini';
  if (cisco >= 2) return 'cisco';
  return null;
}

/**
 * The language for a file: exact file name, then a telling extension, then
 * the content, then the extension's usual meaning, then plain text.
 */
export function detectLanguage(name: string, text: string): string {
  const lower = name.toLowerCase();
  const fromName = byFileName(lower);
  if (fromName) return fromName;
  if (/(?:^|[\\/])nginx[^\\/]*\.conf$/.test(lower) || /[\\/]nginx[\\/]/.test(lower)) return 'nginx';
  const fromExt = byExtension(lower);
  if (fromExt) return fromExt;
  const fromContent = detectFromContent(text, lower);
  if (fromContent) return fromContent;
  const ext = extensionOf(lower);
  if (ext === 'conf' || ext === 'cfg') return 'ini';
  if (ext === 'pp') return 'puppet';
  return 'text';
}

/**
 * Operating systems: the catalog (support dates as data, each with a source),
 * the classifier that reads a VM's guest OS strings, and the name heuristics
 * that guess a server's role and whether it hosts a database.
 *
 * `classifyOs` replaces three private helpers that matched substrings
 * (`from-inventory.ts osFamilyOf`, `terraform/estate.ts osOf`,
 * `ansible/estate.ts osOf`). Those counted any string containing "win" as
 * Windows (so "Darwin" was Windows) and any containing "oracle" as Linux (so a
 * VM described as "Oracle Solaris" was Linux). This reads whole words and
 * versions, and says `unknown` rather than guess.
 */

import type { InventoryVm } from '../../vmware/inventory.ts';
import { OS_LABELS, OS_VALUES, itemId } from './options.ts';
import type { Database, DbEngine, OsFamily, OsId, OsInfo, OsKind, OsLicence, Role, Verification } from './types.ts';

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const MS = (product: string) => `https://learn.microsoft.com/lifecycle/products/${product}`;
const MS_ESU = 'https://www.microsoft.com/en-us/windows-server/extended-security-updates';
const REDHAT = 'https://access.redhat.com/support/policy/updates/errata';
const CENTOS = 'https://www.centos.org/centos-linux-eol/';
const CENTOS_STREAM = 'https://www.centos.org/cl-vs-cs/';
const ROCKY = 'https://wiki.rockylinux.org/rocky/version/';
const ALMA = 'https://wiki.almalinux.org/release-notes/';
const ORACLE_LINUX = 'https://www.oracle.com/a/ocom/docs/elsp-lifetime-069338.pdf';
const SUSE = 'https://www.suse.com/lifecycle/';
const UBUNTU = 'https://ubuntu.com/about/release-cycle';
const DEBIAN = 'https://wiki.debian.org/LTS';

type Entry = Omit<OsInfo, 'id' | 'label'>;

function win(majorVersion: string, eos: string, esu: string | undefined, product: string, verification: Verification = 'V-DOC'): Entry {
  return {
    family: 'windows', kind: 'windows', majorVersion,
    endOfStandardSupport: eos,
    ...(esu ? { endOfExtendedSupport: esu } : {}),
    ...(majorVersion === '2025' ? {} : { upgradeTo: 'win-2025' as OsId }),
    source: esu ? `${MS(product)} ; ${MS_ESU}` : MS(product),
    verification,
  };
}
function linux(
  family: OsFamily,
  majorVersion: string,
  eos: string | undefined,
  extended: string | undefined,
  upgradeTo: OsId | undefined,
  source: string,
  verification: Verification,
): Entry {
  return {
    family, kind: 'linux', majorVersion,
    ...(eos ? { endOfStandardSupport: eos } : {}),
    ...(extended ? { endOfExtendedSupport: extended } : {}),
    ...(upgradeTo ? { upgradeTo } : {}),
    source,
    verification,
  };
}

/**
 * Standard support = the vendor's normal support (Microsoft: end of extended
 * support; Red Hat: end of Maintenance; Canonical: end of standard security
 * maintenance; Debian: end of regular security support). Extended = the paid
 * or community extension: ESU, ELS, Extended Support, LTSS, Ubuntu Pro ESM,
 * Debian LTS.
 */
const ENTRIES: Readonly<Record<OsId, Entry>> = {
  // Windows 2008 R2's paid ESU ended 2023-01-10; Azure had one more free year, to 2024-01-09.
  'win-2008r2': win('2008 R2', '2020-01-14', '2024-01-09', 'windows-server-2008-r2'),
  'win-2012': win('2012', '2023-10-10', '2026-10-13', 'windows-server-2012'),
  'win-2012r2': win('2012 R2', '2023-10-10', '2026-10-13', 'windows-server-2012-r2'),
  'win-2016': win('2016', '2027-01-12', undefined, 'windows-server-2016'),
  'win-2019': win('2019', '2029-01-09', undefined, 'windows-server-2019'),
  'win-2022': win('2022', '2031-10-14', undefined, 'windows-server-2022'),
  'win-2025': win('2025', '2034-11-14', undefined, 'windows-server-2025'),

  // RHEL 6 ELS was extended to 2029 by Red Hat (reported; not re-read here).
  'rhel-6': linux('rhel', '6', '2020-11-30', '2029-06-30', 'rhel-9', REDHAT, 'C'),
  'rhel-7': linux('rhel', '7', '2024-06-30', '2028-06-30', 'rhel-9', REDHAT, 'C'),
  'rhel-8': linux('rhel', '8', '2029-05-31', '2032-05-31', 'rhel-9', REDHAT, 'C'),
  'rhel-9': linux('rhel', '9', '2032-05-31', '2035-05-31', 'rhel-10', REDHAT, 'C'),
  'rhel-10': linux('rhel', '10', '2035-05-31', '2038-05-31', undefined, REDHAT, 'C'),

  'centos-6': linux('rhel', '6', '2020-11-30', undefined, 'rocky-9', CENTOS, 'C'),
  'centos-7': linux('rhel', '7', '2024-06-30', undefined, 'rocky-9', CENTOS, 'C'),
  'centos-8': linux('rhel', '8', '2021-12-31', undefined, 'rocky-9', CENTOS, 'C'),
  'centos-stream-9': linux('rhel', '9', '2027-05-31', undefined, 'rocky-9', CENTOS_STREAM, 'C'),
  // CentOS Stream 10's end follows RHEL 10's full support phase; no date published when this was written.
  'centos-stream-10': linux('rhel', '10', undefined, undefined, 'rocky-10', CENTOS_STREAM, 'I'),

  'rocky-8': linux('rhel', '8', '2029-05-31', undefined, 'rocky-9', ROCKY, 'C'),
  'rocky-9': linux('rhel', '9', '2032-05-31', undefined, 'rocky-10', ROCKY, 'C'),
  'rocky-10': linux('rhel', '10', '2035-05-31', undefined, undefined, ROCKY, 'I'),
  'alma-8': linux('rhel', '8', '2029-03-01', undefined, 'alma-9', ALMA, 'C'),
  'alma-9': linux('rhel', '9', '2032-05-31', undefined, 'alma-10', ALMA, 'C'),
  'alma-10': linux('rhel', '10', '2035-05-31', undefined, undefined, ALMA, 'I'),

  // Oracle Linux: Premier Support end, then Extended Support end.
  'ol-6': linux('rhel', '6', '2021-03-31', '2024-06-30', 'ol-9', ORACLE_LINUX, 'C'),
  // Confirmed 2026-09-26 against Oracle's own release note (Extended Support January 2025 to June 2028).
  'ol-7': linux('rhel', '7', '2024-12-31', '2028-06-30', 'ol-9', 'https://docs.oracle.com/en-us/iaas/releasenotes/compute/ol7-extended-support.htm', 'V-DOC'),
  'ol-8': linux('rhel', '8', '2029-07-31', '2032-07-31', 'ol-9', ORACLE_LINUX, 'C'),
  'ol-9': linux('rhel', '9', '2032-06-30', '2035-06-30', 'ol-10', ORACLE_LINUX, 'C'),
  'ol-10': linux('rhel', '10', undefined, undefined, undefined, ORACLE_LINUX, 'I'),

  // SUSE: general support end, then LTSS end.
  'sles-11': linux('suse', '11', '2019-03-31', '2022-03-31', 'sles-15', SUSE, 'C'),
  // LTSS to October 2027 (LTSS Core to 2030), per SUSE, re-checked 2026-09-26.
  'sles-12': linux('suse', '12', '2024-10-31', '2027-10-31', 'sles-15', SUSE, 'C'),
  'sles-15': linux('suse', '15', '2031-07-31', '2034-07-31', 'sles-16', SUSE, 'C'),
  'sles-16': linux('suse', '16', undefined, undefined, undefined, SUSE, 'I'),

  'ubuntu-16.04': linux('debian', '16.04', '2021-04-30', '2026-04-30', 'ubuntu-24.04', UBUNTU, 'C'),
  'ubuntu-18.04': linux('debian', '18.04', '2023-05-31', '2028-04-30', 'ubuntu-24.04', UBUNTU, 'C'),
  'ubuntu-20.04': linux('debian', '20.04', '2025-05-31', '2030-04-30', 'ubuntu-24.04', UBUNTU, 'C'),
  'ubuntu-22.04': linux('debian', '22.04', '2027-06-30', '2032-04-30', 'ubuntu-24.04', UBUNTU, 'C'),
  'ubuntu-24.04': linux('debian', '24.04', '2029-05-31', '2034-04-30', undefined, UBUNTU, 'C'),

  // Debian: regular security support end, then LTS end.
  'debian-9': linux('debian', '9', '2020-07-06', '2022-06-30', 'debian-12', DEBIAN, 'C'),
  'debian-10': linux('debian', '10', '2022-09-10', '2024-06-30', 'debian-12', DEBIAN, 'C'),
  'debian-11': linux('debian', '11', '2024-08-14', '2026-08-31', 'debian-12', DEBIAN, 'C'),
  'debian-12': linux('debian', '12', '2026-06-10', '2028-06-30', 'debian-13', DEBIAN, 'C'),
  'debian-13': linux('debian', '13', undefined, '2030-06-30', undefined, DEBIAN, 'I'),

  'linux-other': { family: 'other', kind: 'linux', majorVersion: '', source: 'classifier: a Linux guest with no recognised distribution or version', verification: 'I' },
  'windows-client': { family: 'windows', kind: 'windows', majorVersion: '', source: 'classifier: a Windows desktop edition (7, 8, 10, 11)', verification: 'I' },
  other: { family: 'other', kind: 'other', majorVersion: '', source: 'classifier: neither Windows nor Linux (e.g. FreeBSD, Solaris, an appliance)', verification: 'I' },
  unknown: { family: 'other', kind: 'other', majorVersion: '', source: 'classifier: no guest OS string to read', verification: 'I' },
};

export const OS_CATALOG: Readonly<Record<OsId, OsInfo>> = Object.freeze(
  Object.fromEntries(OS_VALUES.map((id) => [id, Object.freeze({ id, label: OS_LABELS[id], ...ENTRIES[id] })])) as Record<OsId, OsInfo>,
);

export function osInfo(id: OsId): OsInfo {
  return OS_CATALOG[id];
}
export function osKind(id: OsId): OsKind {
  return OS_CATALOG[id].kind;
}
export function osFamily(id: OsId): OsFamily {
  return OS_CATALOG[id].family;
}

export type SupportStatus = 'supported' | 'extended' | 'end-of-life' | 'unknown';
/**
 * Where an OS stands on a date (ISO yyyy-mm-dd): in standard support, only in
 * extended (paid) support, or past both. `unknown` when the catalog has no date.
 */
export function supportStatus(id: OsId, on: string): SupportStatus {
  const info = OS_CATALOG[id];
  if (!info.endOfStandardSupport && !info.endOfExtendedSupport) return 'unknown';
  if (info.endOfStandardSupport && on <= info.endOfStandardSupport) return 'supported';
  if (!info.endOfStandardSupport && info.endOfExtendedSupport && on <= info.endOfExtendedSupport) return 'supported';
  if (info.endOfExtendedSupport && on <= info.endOfExtendedSupport) return 'extended';
  return 'end-of-life';
}

/** The Workloads grid's Licence default: Windows, RHEL and SLES licence-included; everything else community. */
export function defaultLicenceFor(id: OsId): OsLicence {
  if (OS_CATALOG[id].kind === 'windows') return 'li';
  if (id.startsWith('rhel-') || id.startsWith('sles-')) return 'li';
  return 'free';
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

const WINDOWS_SERVER_YEAR: Readonly<Record<string, OsId>> = { '2016': 'win-2016', '2019': 'win-2019', '2022': 'win-2022', '2025': 'win-2025' };
const pick = <T extends string>(id: string, allowed: readonly T[]): T | undefined => (allowed as readonly string[]).includes(id) ? (id as T) : undefined;

/** A vSphere guest id (`rhel9_64Guest`), or undefined when the text is not one. */
function fromGuestId(text: string): OsId | undefined {
  const m = /^([a-z0-9]+?)(?:_?64)?guest$/i.exec(text.trim());
  if (!m) return undefined;
  const g = (m[1] ?? '').toLowerCase();
  // Windows Server: the ids are VMware's, and "Next" means the release after the one named.
  const windows: Record<string, OsId | 'other' | 'windows-client'> = {
    windows2022srvnext: 'win-2025',
    windows2019srvnext: 'win-2022',
    windows2019srv: 'win-2019',
    windows9server: 'win-2016',
    windows9srv: 'win-2016',
    // VMware uses one id for 2012 and 2012 R2; R2 is the far commoner, and their dates are identical.
    windows8server: 'win-2012r2',
    windows8srv: 'win-2012r2',
    windows7server: 'win-2008r2',
    windows7srv: 'win-2008r2',
    winlonghorn: 'other',
    winnetenterprise: 'other',
    winnetstandard: 'other',
    winnetdatacenter: 'other',
    windows7: 'windows-client',
    windows8: 'windows-client',
    windows9: 'windows-client',
    windows11: 'windows-client',
    windows12: 'windows-client',
    winxppro: 'windows-client',
    winvista: 'windows-client',
  };
  if (Object.hasOwn(windows, g)) return windows[g];
  let v: RegExpExecArray | null;
  if ((v = /^rhel(\d+)$/.exec(g))) return pick(`rhel-${v[1]}`, OS_VALUES) ?? 'linux-other';
  if ((v = /^centos(\d+)$/.exec(g))) {
    const n = Number(v[1]);
    return n >= 9 ? (pick(`centos-stream-${n}`, OS_VALUES) ?? 'linux-other') : (pick(`centos-${n}`, OS_VALUES) ?? 'linux-other');
  }
  if ((v = /^oraclelinux(\d+)$/.exec(g))) return pick(`ol-${v[1]}`, OS_VALUES) ?? 'linux-other';
  if ((v = /^sles(\d+)$/.exec(g))) return pick(`sles-${v[1]}`, OS_VALUES) ?? 'linux-other';
  if ((v = /^debian(\d+)$/.exec(g))) return pick(`debian-${v[1]}`, OS_VALUES) ?? 'linux-other';
  if ((v = /^rockylinux(\d+)?$/.exec(g))) return v[1] ? (pick(`rocky-${v[1]}`, OS_VALUES) ?? 'linux-other') : 'linux-other';
  if ((v = /^almalinux(\d+)?$/.exec(g))) return v[1] ? (pick(`alma-${v[1]}`, OS_VALUES) ?? 'linux-other') : 'linux-other';
  if (/^(ubuntu|centos|oraclelinux|sles|opensuse|rhel|redhat|fedora|coreos|mandrake|mandriva|asianux\d*|miraclelinux\d*|turbolinux|suse|photon|amazonlinux\d*|vmwarephoton|other\d*x?linux|other\d+xlinux|otherlinux|linux)$/.test(g) || /linux/.test(g)) {
    return 'linux-other';
  }
  if (/^(freebsd\d*|solaris\d*|darwin\d*|netware\d*|os2|dos|other|otherguest|eComStation\d*)$/i.test(g)) return 'other';
  return 'other';
}

/** A person-readable OS string ("Microsoft Windows Server 2016 (64-bit)", "Ubuntu 22.04.4 LTS"). */
function fromText(raw: string): OsId {
  const t = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  // Windows. Whole word "windows" only, so "Darwin" is not Windows.
  if (/\bwindows\b/.test(t)) {
    const server = /\bwindows(?: server| srv)? ?(2003|2008|2012|2016|2019|2022|2025)( ?r2)?\b/.exec(t);
    if (server) {
      const r2 = !!server[2];
      if (server[1] === '2008') return r2 ? 'win-2008r2' : 'other';
      if (server[1] === '2012') return r2 ? 'win-2012r2' : 'win-2012';
      return WINDOWS_SERVER_YEAR[server[1] ?? ''] ?? 'other';
    }
    if (/\bwindows (?:7|8(?:\.1)?|10|11|xp|vista)\b/.test(t)) return 'windows-client';
    return 'other';
  }

  // Linux families, most specific first. A number after a slash ("CentOS 4/5/6/7") is ambiguous.
  const version = (re: RegExp): string | undefined => {
    const m = re.exec(t);
    if (!m) return undefined;
    const after = t.slice((m.index ?? 0) + m[0].length);
    if (after.startsWith('/')) return undefined;
    return m[1];
  };
  const major = (re: RegExp, prefix: string): OsId => {
    const v = version(re);
    return v ? (pick(`${prefix}${v}`, OS_VALUES) ?? 'linux-other') : 'linux-other';
  };

  if (/\bcentos stream\b/.test(t)) return major(/centos stream(?: release)? (\d+)/, 'centos-stream-');
  if (/\bcentos\b/.test(t)) {
    const v = version(/centos(?: linux)?(?: release)? (\d+)/);
    if (!v) return 'linux-other';
    return Number(v) >= 9 ? (pick(`centos-stream-${v}`, OS_VALUES) ?? 'linux-other') : (pick(`centos-${v}`, OS_VALUES) ?? 'linux-other');
  }
  if (/\brocky\b/.test(t)) return major(/rocky(?: linux)?(?: release)? (\d+)/, 'rocky-');
  if (/\balma ?linux\b/.test(t)) return major(/alma ?linux(?: os)?(?: release)? (\d+)/, 'alma-');
  if (/\boracle (?:enterprise )?linux\b|\boraclelinux\b|\bol\d+\b|\boel\b/.test(t)) {
    const v = version(/(?:oracle (?:enterprise )?linux|oraclelinux)(?: server)?(?: release)? (\d+)/) ?? version(/\bol(\d+)\b/) ?? version(/\boel ?(\d+)\b/);
    return v ? (pick(`ol-${v}`, OS_VALUES) ?? 'linux-other') : 'linux-other';
  }
  if (/\bred ?hat\b|\brhel\b/.test(t)) {
    const v = version(/(?:red ?hat enterprise linux|rhel)(?: server| workstation| for sap)?(?: release)? ?(\d+)/);
    return v ? (pick(`rhel-${v}`, OS_VALUES) ?? 'linux-other') : 'linux-other';
  }
  if (/\bopensuse\b/.test(t)) return 'linux-other';
  if (/\bsuse\b|\bsles\b/.test(t)) {
    const v = version(/(?:suse linux enterprise(?: server)?|sles)(?: for sap applications)? ?(\d+)/);
    return v ? (pick(`sles-${v}`, OS_VALUES) ?? 'linux-other') : 'linux-other';
  }
  if (/\bubuntu\b/.test(t)) {
    const m = /ubuntu(?: linux)?(?: server)? (\d{2})\.(\d{2})/.exec(t);
    return m ? (pick(`ubuntu-${m[1]}.${m[2]}`, OS_VALUES) ?? 'linux-other') : 'linux-other';
  }
  if (/\bdebian\b/.test(t)) return major(/debian(?: gnu\/linux)? (\d+)/, 'debian-');
  if (/\blinux\b|\bphoton\b|\bfedora\b|\bamazon linux\b|\bcoreos\b/.test(t)) return 'linux-other';
  if (/\bfreebsd\b|\bsolaris\b|\bnetware\b|\bos\/2\b|\bdos\b|\bother\b|\bdarwin\b|\bmac ?os\b|\bappliance\b/.test(t)) return 'other';
  return 'unknown';
}

/**
 * One OS string to an `OsId`. Pure. Reads vSphere guest ids (`windows2019srvNext_64Guest`
 * is 2022) and the human strings RVTools and CMDBs carry. Empty is `unknown`.
 */
export function classifyOs(text: string | undefined | null): OsId {
  const t = (text ?? '').trim();
  if (t === '') return 'unknown';
  if (/^[a-z0-9_]+guest$/i.test(t)) return fromGuestId(t) ?? 'other';
  if (/^other(?:guest)?(?:64)?$/i.test(t)) return 'other';
  return fromText(t);
}

/** Less specific results rank lower, so a later string that names the version wins. */
const VAGUE: readonly OsId[] = ['unknown', 'linux-other', 'other'];

/**
 * A VM's OS: VMware Tools' view first, then the detailed pretty name, then the
 * configured guest OS. The first that is specific wins; else the first that is
 * not `unknown` (so `ubuntu64Guest` with a pretty name "Ubuntu 22.04.4 LTS" is
 * `ubuntu-22.04`, and on its own is `linux-other`).
 */
export function classifyVm(vm: Pick<InventoryVm, 'guestOsTools' | 'guestDetail' | 'guestOs'>): OsId {
  const candidates = [vm.guestOsTools, vm.guestDetail?.prettyName, vm.guestOs, vm.guestDetail?.familyName];
  const results = candidates.map((c) => classifyOs(c));
  const specific = results.find((r) => !VAGUE.includes(r));
  if (specific) return specific;
  return results.find((r) => r !== 'unknown') ?? 'unknown';
}

/** The strings `classifyVm` read, joined, for the Workloads detail panel. */
export function guestOsRaw(vm: Pick<InventoryVm, 'guestOsTools' | 'guestDetail' | 'guestOs'>): string {
  return [vm.guestOsTools, vm.guestDetail?.prettyName, vm.guestOs].filter((s): s is string => !!s && s.trim() !== '').join(' | ');
}

// ---------------------------------------------------------------------------
// Role and database heuristics
// ---------------------------------------------------------------------------

/** `(^|[^a-z])` before a short token, so "storage" is not Oracle and "common" is not monitoring. */
const B = '(?:^|[^a-z])';
const ROLE_RULES: readonly (readonly [RegExp, Role])[] = [
  [new RegExp(`${B}dc\\d|addc|domctl|${B}adds?${B}`), 'ad-dc'],
  [new RegExp(`sql|${B}ora(?:cle)?|${B}orcl|${B}db\\d|${B}db${B}|${B}pg|postgres|mysql|maria|mongo|${B}db2`), 'db'],
  [new RegExp(`${B}web|${B}www|${B}iis|nginx|apache|${B}ws\\d`), 'web'],
  [new RegExp(`${B}app|${B}api|${B}svc`), 'app'],
  [new RegExp(`${B}fs\\d|${B}file|${B}nas${B}|${B}nas\\d|${B}smb`), 'file'],
  [new RegExp(`${B}dns|dhcp|ipam`), 'dns-dhcp'],
  [new RegExp(`${B}rds|citrix|${B}xa\\d|${B}xa${B}|${B}vdi|${B}ctx`), 'rds-vdi'],
  [new RegExp(`${B}mq|kafka|rabbit|${B}esb`), 'messaging'],
  [new RegExp(`jump|bastion|${B}jmp`), 'jump'],
  [new RegExp(`${B}bkp|backup|veeam|commvault`), 'backup'],
  [new RegExp(`${B}mon${B}|${B}mon\\d|zabbix|nagios|splunk|${B}prom`), 'monitoring'],
];

/**
 * A role from a server's name, else its annotation and custom attribute values.
 * The rules run in the order of design section 2.4.1; the first match wins.
 */
export function roleFromName(name: string, annotation?: string, attrs?: Readonly<Record<string, string>>): Role {
  const texts = [name, [annotation ?? '', ...Object.values(attrs ?? {})].join(' ')];
  for (const text of texts) {
    const t = text.toLowerCase();
    if (t.trim() === '') continue;
    for (const [re, role] of ROLE_RULES) if (re.test(t)) return role;
  }
  return 'other';
}

/** Engine hints, most specific first ("mysql" contains "sql"). */
const ENGINE_RULES: readonly (readonly [RegExp, DbEngine | 'sql'])[] = [
  [/maria/, 'mariadb'],
  [/mysql/, 'mysql'],
  [new RegExp(`postgres|pgsql|${B}pg(?:\\d|${B}|sql)`), 'postgres'],
  [/mongo/, 'mongodb'],
  [new RegExp(`${B}db2`), 'db2'],
  [/sybase|${B}ase\d/, 'sybase-ase'],
  [new RegExp(`oracle|${B}ora(?:\\d|${B}|db|cle)|${B}orcl`), 'oracle'],
  [/mssql|sql ?server/, 'sqlserver'],
  [/sql/, 'sql'],
];

/**
 * A database row suggested by a VM's name, annotation or custom attributes.
 * `sql` alone means SQL Server only on Windows. The edition and version are left
 * unconfirmed (`commercial` or `community`, and `other`) for the user, and the
 * row is marked `inferred`. Undefined when nothing suggests a database.
 */
export function dbFromVm(
  vm: Pick<InventoryVm, 'name' | 'vcpu' | 'memoryGib' | 'provisionedGib' | 'annotation' | 'customAttributes' | 'guestOsTools' | 'guestDetail' | 'guestOs'>,
  os: OsId = classifyVm(vm),
): Partial<Database> | undefined {
  const text = [vm.name, vm.annotation ?? '', ...Object.values(vm.customAttributes ?? {})].join(' ').toLowerCase();
  let engine: DbEngine | undefined;
  for (const [re, found] of ENGINE_RULES) {
    if (!re.test(text)) continue;
    if (found === 'sql') {
      if (osKind(os) === 'windows') engine = 'sqlserver';
      else continue;
    } else engine = found;
    break;
  }
  if (!engine) return undefined;
  const open = engine === 'postgres' || engine === 'mysql' || engine === 'mariadb' || engine === 'mongodb';
  return {
    id: itemId('database', vm.name),
    name: vm.name,
    engine,
    edition: open ? 'community' : 'commercial',
    version: 'other',
    hosts: [vm.name],
    vcpu: vm.vcpu,
    ramGib: Math.ceil(vm.memoryGib),
    sizeGib: Math.ceil(vm.provisionedGib),
    ha: 'none',
    dr: 'none',
    features: [],
    ...(open ? { licence: 'community' as const } : {}),
    app: '',
    inferred: true,
    source: 'estate',
  };
}

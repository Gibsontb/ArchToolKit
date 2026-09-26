/**
 * The image each OS boots from on each hyperscaler, as data: an `ImageRef` the
 * Terraform blueprints resolve at plan time (an SSM parameter, an AMI filter,
 * a Marketplace URN, an image family, an OCI platform image filter), or an
 * explicit reason there is none.
 *
 * Images are looked up by reference, never by a literal id: an AMI id copied
 * from one region fails in the next, and a family or parameter always gives
 * the current patched build. Where no image is published (an OS past support,
 * or a distribution the provider does not publish), the entry says why, and
 * the workload is replicated (the replication tool brings the disk) or given a
 * custom-image variable.
 *
 * Owners, SKUs and families marked (verify) are the providers' published names
 * as last read; `catalogs.test.ts` checks every Google family against
 * `GCP_IMAGE_FAMILIES` and every AWS parameter's form.
 */

import type { Platform } from '../platforms.ts';
import { OS_VALUES } from './options.ts';
import type { Hyperscaler, ImageRef, OsId, OsLicence } from './types.ts';

export interface Unavailable {
  readonly unavailable: string;
}
export type ImageEntry = ImageRef | Unavailable;

export function isUnavailable(entry: ImageEntry | undefined): entry is Unavailable {
  return !!entry && 'unavailable' in entry;
}

// ---- builders ----------------------------------------------------------------

const ssm = (parameter: string): ImageRef => ({ kind: 'aws-ssm', parameter });
const ami = (owner: string, namePattern: string): ImageRef => ({ kind: 'aws-ami-filter', owner, namePattern });
const az = (publisher: string, offer: string, sku: string, plan?: boolean): ImageRef => ({
  kind: 'azure-marketplace', publisher, offer, sku, ...(plan ? { plan: true } : {}),
});
const gcp = (project: string, family: string): ImageRef => ({ kind: 'gcp-family', project, family });
const oci = (operatingSystem: string, version: string): ImageRef => ({ kind: 'oci-platform', operatingSystem, version });
/** OCI publishes only Oracle Linux, Ubuntu and Windows as platform images: anything else is imported. */
const ociCustom = (os: OsId): ImageRef => ({
  kind: 'custom',
  variable: `image_ocid_${os.replace(/[^a-z0-9]+/g, '_')}`,
  note: 'OCI has no platform image for this OS: import one (https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/importingcustomimagelinux.htm) and give its OCID.',
});
const no = (unavailable: string): Unavailable => ({ unavailable });

const PAST = (what: string) => no(`${what} is past standard support and no longer published as a current image: replicate it, then upgrade after landing.`);
const NOT_PUBLISHED = (what: string, where: string) => no(`${where} publishes no image for ${what}: replicate it, or import a custom image.`);

// AWS owners (verify): Red Hat, Rocky (RESF), AlmaLinux, Oracle, SUSE, Debian, CentOS.
const AWS_OWNER = {
  redhat: '309956199498',
  rocky: '792107900819',
  alma: '764336703387',
  oracle: '131827586825',
  suse: '013907871322',
  debian: '136693071363',
  centos: '125523088429',
} as const;
const winSsm = (year: string) => ssm(`/aws/service/ami-windows-latest/Windows_Server-${year}-English-Full-Base`);
const ubuntuSsm = (version: string, volume: 'ebs-gp2' | 'ebs-gp3') => ssm(`/aws/service/canonical/ubuntu/server/${version}/stable/current/amd64/hvm/${volume}/ami-id`);

type Row = Readonly<Record<Hyperscaler, ImageEntry>>;
const WINDOWS_CLIENT = no('Windows desktop editions are not licensed for cloud servers: move the users to a virtual-desktop service, or replicate the VM.');
const UNKNOWN_LINUX = no('The distribution and version are not known: pick the OS on the Workloads screen, or replicate the VM.');

export const IMAGE_TABLE: Readonly<Record<OsId, Partial<Record<Hyperscaler, ImageEntry>>>> = Object.freeze({
  // ---- Windows Server ---------------------------------------------------------
  'win-2008r2': { aws: PAST('Windows Server 2008 R2'), azure: PAST('Windows Server 2008 R2'), google: PAST('Windows Server 2008 R2'), oci: PAST('Windows Server 2008 R2') } satisfies Row,
  'win-2012': {
    aws: no('AWS publishes no current Windows Server 2012 AMI: replicate, or upgrade.'),
    // Still published, and ESUs are free on Azure.
    azure: az('MicrosoftWindowsServer', 'WindowsServer', '2012-datacenter-gensecond'),
    google: PAST('Windows Server 2012'),
    oci: PAST('Windows Server 2012'),
  } satisfies Row,
  'win-2012r2': {
    aws: no('AWS publishes no current Windows Server 2012 R2 AMI: replicate, or upgrade.'),
    azure: az('MicrosoftWindowsServer', 'WindowsServer', '2012-r2-datacenter-gensecond'),
    google: PAST('Windows Server 2012 R2'),
    oci: PAST('Windows Server 2012 R2'),
  } satisfies Row,
  'win-2016': { aws: winSsm('2016'), azure: az('MicrosoftWindowsServer', 'WindowsServer', '2016-datacenter-gensecond'), google: gcp('windows-cloud', 'windows-2016'), oci: oci('Windows', 'Server 2016 Standard') } satisfies Row,
  'win-2019': { aws: winSsm('2019'), azure: az('MicrosoftWindowsServer', 'WindowsServer', '2019-datacenter-gensecond'), google: gcp('windows-cloud', 'windows-2019'), oci: oci('Windows', 'Server 2019 Standard') } satisfies Row,
  'win-2022': { aws: winSsm('2022'), azure: az('MicrosoftWindowsServer', 'WindowsServer', '2022-datacenter-azure-edition'), google: gcp('windows-cloud', 'windows-2022'), oci: oci('Windows', 'Server 2022 Standard') } satisfies Row,
  'win-2025': { aws: winSsm('2025'), azure: az('MicrosoftWindowsServer', 'WindowsServer', '2025-datacenter-azure-edition'), google: gcp('windows-cloud', 'windows-2025'), oci: oci('Windows', 'Server 2025 Standard') } satisfies Row,
  'windows-client': { aws: WINDOWS_CLIENT, azure: WINDOWS_CLIENT, google: WINDOWS_CLIENT, oci: WINDOWS_CLIENT } satisfies Row,

  // ---- RHEL family --------------------------------------------------------------
  'rhel-6': { aws: PAST('RHEL 6'), azure: PAST('RHEL 6'), google: PAST('RHEL 6'), oci: ociCustom('rhel-6') } satisfies Row,
  'rhel-7': { aws: PAST('RHEL 7'), azure: PAST('RHEL 7'), google: PAST('RHEL 7'), oci: ociCustom('rhel-7') } satisfies Row,
  'rhel-8': { aws: ami(AWS_OWNER.redhat, 'RHEL-8.*_HVM-*-x86_64-*'), azure: az('RedHat', 'RHEL', '8-lvm-gen2'), google: gcp('rhel-cloud', 'rhel-8'), oci: ociCustom('rhel-8') } satisfies Row,
  'rhel-9': { aws: ami(AWS_OWNER.redhat, 'RHEL-9.*_HVM-*-x86_64-*'), azure: az('RedHat', 'RHEL', '9-lvm-gen2'), google: gcp('rhel-cloud', 'rhel-9'), oci: ociCustom('rhel-9') } satisfies Row,
  // (verify) the Azure RHEL 10 SKU.
  'rhel-10': { aws: ami(AWS_OWNER.redhat, 'RHEL-10.*_HVM-*-x86_64-*'), azure: az('RedHat', 'RHEL', '10-lvm-gen2'), google: gcp('rhel-cloud', 'rhel-10'), oci: ociCustom('rhel-10') } satisfies Row,

  'centos-6': { aws: PAST('CentOS 6'), azure: PAST('CentOS 6'), google: PAST('CentOS 6'), oci: PAST('CentOS 6') } satisfies Row,
  'centos-7': { aws: PAST('CentOS 7'), azure: PAST('CentOS 7'), google: PAST('CentOS 7'), oci: PAST('CentOS 7') } satisfies Row,
  'centos-8': { aws: PAST('CentOS 8'), azure: PAST('CentOS 8'), google: PAST('CentOS 8'), oci: PAST('CentOS 8') } satisfies Row,
  'centos-stream-9': {
    aws: ami(AWS_OWNER.centos, 'CentOS Stream 9 x86_64*'),
    azure: NOT_PUBLISHED('CentOS Stream 9', 'The CentOS Project'),
    google: gcp('centos-cloud', 'centos-stream-9'),
    oci: ociCustom('centos-stream-9'),
  } satisfies Row,
  'centos-stream-10': {
    aws: ami(AWS_OWNER.centos, 'CentOS Stream 10 x86_64*'),
    azure: NOT_PUBLISHED('CentOS Stream 10', 'The CentOS Project'),
    google: gcp('centos-cloud', 'centos-stream-10'),
    oci: ociCustom('centos-stream-10'),
  } satisfies Row,

  'rocky-8': { aws: ami(AWS_OWNER.rocky, 'Rocky-8-EC2-Base-*x86_64*'), azure: az('resf', 'rockylinux-x86_64', '8-base', true), google: gcp('rocky-linux-cloud', 'rocky-linux-8'), oci: ociCustom('rocky-8') } satisfies Row,
  'rocky-9': { aws: ami(AWS_OWNER.rocky, 'Rocky-9-EC2-Base-*x86_64*'), azure: az('resf', 'rockylinux-x86_64', '9-base', true), google: gcp('rocky-linux-cloud', 'rocky-linux-9'), oci: ociCustom('rocky-9') } satisfies Row,
  // (verify) Rocky 10's AMI name and Azure SKU.
  'rocky-10': { aws: ami(AWS_OWNER.rocky, 'Rocky-10-EC2-Base-*x86_64*'), azure: az('resf', 'rockylinux-x86_64', '10-base', true), google: gcp('rocky-linux-cloud', 'rocky-linux-10'), oci: ociCustom('rocky-10') } satisfies Row,

  'alma-8': { aws: ami(AWS_OWNER.alma, 'AlmaLinux OS 8*x86_64*'), azure: az('almalinux', 'almalinux-x86_64', '8-gen2'), google: gcp('almalinux-cloud', 'almalinux-8'), oci: ociCustom('alma-8') } satisfies Row,
  'alma-9': { aws: ami(AWS_OWNER.alma, 'AlmaLinux OS 9*x86_64*'), azure: az('almalinux', 'almalinux-x86_64', '9-gen2'), google: gcp('almalinux-cloud', 'almalinux-9'), oci: ociCustom('alma-9') } satisfies Row,
  // (verify) AlmaLinux 10's Azure SKU.
  'alma-10': { aws: ami(AWS_OWNER.alma, 'AlmaLinux OS 10*x86_64*'), azure: az('almalinux', 'almalinux-x86_64', '10-gen2'), google: gcp('almalinux-cloud', 'almalinux-10'), oci: ociCustom('alma-10') } satisfies Row,

  'ol-6': { aws: PAST('Oracle Linux 6'), azure: PAST('Oracle Linux 6'), google: PAST('Oracle Linux 6'), oci: PAST('Oracle Linux 6') } satisfies Row,
  'ol-7': {
    aws: PAST('Oracle Linux 7'),
    azure: PAST('Oracle Linux 7'),
    google: PAST('Oracle Linux 7'),
    // OCI still publishes 7.9, for Extended Support customers.
    oci: oci('Oracle Linux', '7.9'),
  } satisfies Row,
  'ol-8': { aws: ami(AWS_OWNER.oracle, 'OL8.*-x86_64-HVM-*'), azure: az('Oracle', 'Oracle-Linux', 'ol810-lvm-gen2'), google: gcp('oracle-linux-cloud', 'oracle-linux-8'), oci: oci('Oracle Linux', '8') } satisfies Row,
  'ol-9': { aws: ami(AWS_OWNER.oracle, 'OL9.*-x86_64-HVM-*'), azure: az('Oracle', 'Oracle-Linux', 'ol94-lvm-gen2'), google: gcp('oracle-linux-cloud', 'oracle-linux-9'), oci: oci('Oracle Linux', '9') } satisfies Row,
  // (verify) Oracle Linux 10 on AWS and OCI.
  'ol-10': {
    aws: ami(AWS_OWNER.oracle, 'OL10.*-x86_64-HVM-*'),
    azure: NOT_PUBLISHED('Oracle Linux 10', 'No Oracle-published Azure Marketplace image was confirmed; Azure'),
    google: gcp('oracle-linux-cloud', 'oracle-linux-10'),
    oci: oci('Oracle Linux', '10'),
  } satisfies Row,

  // ---- SUSE --------------------------------------------------------------------
  'sles-11': { aws: PAST('SLES 11'), azure: PAST('SLES 11'), google: PAST('SLES 11'), oci: ociCustom('sles-11') } satisfies Row,
  'sles-12': {
    aws: PAST('SLES 12'),
    azure: PAST('SLES 12'),
    // Google still lists the sles-12 family (LTSS).
    google: gcp('suse-cloud', 'sles-12'),
    oci: ociCustom('sles-12'),
  } satisfies Row,
  'sles-15': { aws: ami(AWS_OWNER.suse, 'suse-sles-15-sp*-v*-hvm-ssd-x86_64'), azure: az('SUSE', 'sles-15-sp6', 'gen2'), google: gcp('suse-cloud', 'sles-15'), oci: ociCustom('sles-15') } satisfies Row,
  // (verify) SLES 16 image names on AWS.
  'sles-16': {
    aws: ami(AWS_OWNER.suse, 'suse-sles-16-*-hvm-ssd-x86_64'),
    azure: NOT_PUBLISHED('SLES 16', 'No SUSE Azure Marketplace SKU was confirmed; Azure'),
    google: NOT_PUBLISHED('SLES 16', 'GCP_IMAGE_FAMILIES lists no sles-16 family; Google Cloud (GCP)'),
    oci: ociCustom('sles-16'),
  } satisfies Row,

  // ---- Debian family -------------------------------------------------------------
  'ubuntu-16.04': { aws: PAST('Ubuntu 16.04'), azure: PAST('Ubuntu 16.04'), google: PAST('Ubuntu 16.04'), oci: PAST('Ubuntu 16.04') } satisfies Row,
  'ubuntu-18.04': { aws: PAST('Ubuntu 18.04'), azure: PAST('Ubuntu 18.04'), google: PAST('Ubuntu 18.04'), oci: PAST('Ubuntu 18.04') } satisfies Row,
  // Past standard support (ESM to 2030), still published.
  'ubuntu-20.04': { aws: ubuntuSsm('20.04', 'ebs-gp2'), azure: az('Canonical', '0001-com-ubuntu-server-focal', '20_04-lts-gen2'), google: gcp('ubuntu-os-cloud', 'ubuntu-2004-lts'), oci: oci('Canonical Ubuntu', '20.04') } satisfies Row,
  'ubuntu-22.04': { aws: ubuntuSsm('22.04', 'ebs-gp2'), azure: az('Canonical', '0001-com-ubuntu-server-jammy', '22_04-lts-gen2'), google: gcp('ubuntu-os-cloud', 'ubuntu-2204-lts'), oci: oci('Canonical Ubuntu', '22.04') } satisfies Row,
  'ubuntu-24.04': { aws: ubuntuSsm('24.04', 'ebs-gp3'), azure: az('Canonical', 'ubuntu-24_04-lts', 'server'), google: gcp('ubuntu-os-cloud', 'ubuntu-2404-lts-amd64'), oci: oci('Canonical Ubuntu', '24.04') } satisfies Row,

  'debian-9': { aws: PAST('Debian 9'), azure: PAST('Debian 9'), google: PAST('Debian 9'), oci: ociCustom('debian-9') } satisfies Row,
  'debian-10': { aws: PAST('Debian 10'), azure: PAST('Debian 10'), google: PAST('Debian 10'), oci: ociCustom('debian-10') } satisfies Row,
  'debian-11': { aws: ami(AWS_OWNER.debian, 'debian-11-amd64-*'), azure: az('Debian', 'debian-11', '11-gen2'), google: gcp('debian-cloud', 'debian-11'), oci: ociCustom('debian-11') } satisfies Row,
  'debian-12': { aws: ami(AWS_OWNER.debian, 'debian-12-amd64-*'), azure: az('Debian', 'debian-12', '12-gen2'), google: gcp('debian-cloud', 'debian-12'), oci: ociCustom('debian-12') } satisfies Row,
  // (verify) the Azure Debian 13 SKU.
  'debian-13': { aws: ami(AWS_OWNER.debian, 'debian-13-amd64-*'), azure: az('Debian', 'debian-13', '13-gen2'), google: gcp('debian-cloud', 'debian-13'), oci: ociCustom('debian-13') } satisfies Row,

  // ---- Other ---------------------------------------------------------------------
  'linux-other': { aws: UNKNOWN_LINUX, azure: UNKNOWN_LINUX, google: UNKNOWN_LINUX, oci: UNKNOWN_LINUX } satisfies Row,
  other: {},
  unknown: {},
});

// ---------------------------------------------------------------------------
// SQL Server licence-included images (chosen by the database mapper)
// ---------------------------------------------------------------------------

export type SqlImageEdition = 'enterprise' | 'standard' | 'web';
export type SqlImageVersion = 'sql-2019' | 'sql-2022';

/**
 * Google's `windows-sql-cloud` families. Not in `GCP_IMAGE_FAMILIES`
 * (kit/choices.ts), so kept here with their source.
 * https://cloud.google.com/compute/docs/instances/sql-server/creating-sql-server-instances
 */
export const GCP_SQL_IMAGE_FAMILIES: readonly string[] = Object.freeze([
  'sql-ent-2022-win-2022', 'sql-std-2022-win-2022', 'sql-web-2022-win-2022',
  'sql-ent-2019-win-2019', 'sql-std-2019-win-2019', 'sql-web-2019-win-2019',
]);

const SQL_OS: Readonly<Record<SqlImageVersion, OsId>> = { 'sql-2019': 'win-2019', 'sql-2022': 'win-2022' };
const AWS_SQL: Readonly<Record<SqlImageEdition, string>> = { enterprise: 'Enterprise', standard: 'Standard', web: 'Web' };
const GCP_SQL: Readonly<Record<SqlImageEdition, string>> = { enterprise: 'ent', standard: 'std', web: 'web' };

/** SQL Server, licence included, on its own Windows release; undefined where there is no such image. */
export function sqlImageFor(version: SqlImageVersion, edition: SqlImageEdition, platform: Platform): ImageEntry | undefined {
  const year = version.slice(4);
  const ws = SQL_OS[version].slice(4);
  switch (platform) {
    case 'aws':
      return ssm(`/aws/service/ami-windows-latest/Windows_Server-${ws}-English-Full-SQL_${year}_${AWS_SQL[edition]}`);
    case 'azure':
      return az('MicrosoftSQLServer', `sql${year}-ws${ws}`, `${edition}-gen2`);
    case 'google':
      return gcp('windows-sql-cloud', `sql-${GCP_SQL[edition]}-${year}-win-${ws}`);
    case 'oci':
      return no('OCI publishes no SQL Server image: install SQL Server on a Windows image (BYOL through the Flexible Virtualization Benefit).');
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// imageFor
// ---------------------------------------------------------------------------

export interface ImageOptions {
  /** A licence-included SQL Server image instead of the plain OS (IaaS SQL rows that are LI). */
  readonly sqlEdition?: SqlImageEdition;
  readonly sqlVersion?: SqlImageVersion;
  /** The workload's OS licence: Windows BYOL needs an imported image at AWS, Google Cloud (GCP) and OCI. */
  readonly licence?: OsLicence;
  /** vSphere template names per OS, from the design screen's `OS | Template` grid. */
  readonly vsphereTemplates?: Partial<Record<OsId, string>>;
}

/**
 * The image for `os` on `platform`. Windows BYOL at AWS, Google Cloud (GCP) or
 * OCI is a custom-image variable (those providers' own Windows images are
 * licence-included). RHEL / SLES BYOS on Azure keeps the pay-as-you-go image:
 * the VM's `license_type` (RHEL_BYOS / SLES_BYOS) converts it.
 */
export function imageFor(os: OsId, platform: Platform, options: ImageOptions = {}): ImageEntry {
  if (platform === 'vmware') {
    return { kind: 'vsphere-template', template: options.vsphereTemplates?.[os] ?? `${os}-template` };
  }
  if (options.sqlEdition && options.sqlVersion && os === SQL_OS[options.sqlVersion]) {
    const sql = sqlImageFor(options.sqlVersion, options.sqlEdition, platform);
    if (sql && !isUnavailable(sql)) return sql;
  }
  const byolWindows = os.startsWith('win-') && (options.licence === 'byol-sa' || options.licence === 'byol-perpetual');
  if (byolWindows && platform !== 'azure') {
    return {
      kind: 'custom',
      variable: `image_byol_${os.replace(/[^a-z0-9]+/g, '_')}`,
      note: platform === 'oci'
        ? 'OCI requires an imported image for Windows BYOL: import your own Windows Server image and give its OCID.'
        : 'BYOL Windows on a dedicated host / sole-tenant node needs your own imported image (VM Import / image import).',
    };
  }
  const entry = IMAGE_TABLE[os][platform];
  return entry ?? no('No image for an OS that is neither Windows nor Linux: replicate the VM, or rebuild it as a supported OS.');
}

/** Every OS the table must cover on every hyperscaler (all but `other` / `unknown`). */
export const IMAGED_OS: readonly OsId[] = Object.freeze(OS_VALUES.filter((os) => os !== 'other' && os !== 'unknown'));

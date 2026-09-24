/**
 * Answer sets for the generator inputs.
 *
 * Almost every field on these forms has a known set of sensible answers, and a
 * text box for one of them just moves the error to plan time, where the message
 * names the argument rather than the value. So the rules here turn inputs into
 * dropdowns wherever an answer set exists.
 *
 * Three kinds, because three kinds of question exist:
 *
 *  - `select` where the set is genuinely closed. A storage replication type is
 *    one of six things; anything else is rejected by the provider, so offering
 *    a seventh would be a lie.
 *  - `combo` where the set is long, changes between releases, or is partly
 *    yours. An instance type, an image, a subnet CIDR. The dropdown suggests
 *    the answers and still accepts anything typed, so it helps without getting
 *    in the way.
 *  - free text, left alone, for the questions where there is nothing to offer:
 *    the name of your bucket, an OCID out of your tenancy, an SSH public key.
 *    A dropdown of invented bucket names would be worse than the box.
 *
 * The rules match on input id and platform rather than on a per-blueprint list,
 * so they apply to all of the blueprints at once and to any added later.
 *
 * Where the answer set is a vendor's machine catalogue it lives in
 * sizes-data.ts, which is generated; everything else is here, with the source
 * written against it.
 */

import type { Blueprint, BlueprintGroup, BlueprintInput, SelectOption } from './blueprint.ts';
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, GCP_ZONES, OCI_REGIONS } from './regions.ts';
import {
  AWS_DB_INSTANCE_CLASS_GROUPS,
  AWS_INSTANCE_TYPE_GROUPS,
  AZURE_VM_SIZE_GROUPS,
  GCP_MACHINE_TYPE_GROUPS,
  OCI_SHAPE_GROUPS,
  type GroupedValues,
} from './sizes-data.ts';

const opts = (values: readonly string[]): readonly SelectOption[] =>
  values.map((value) => ({ value, label: value }));

/** A generated catalogue, unpacked into options that carry their heading. */
const grouped = (groups: GroupedValues): readonly SelectOption[] =>
  Object.entries(groups).flatMap(([group, joined]) =>
    joined.split(',').map((value) => ({ value, label: value, group })),
  );

/** A list under one heading. */
const under = (group: string, values: readonly string[]): readonly SelectOption[] =>
  values.map((value) => ({ value, label: value, group }));

/** `{ '80': 'HTTP' }` to options labelled "80 — HTTP". */
const described = (entries: Readonly<Record<string, string>>): readonly SelectOption[] =>
  Object.entries(entries).map(([value, note]) => ({ value, label: `${value} — ${note}` }));

const counts = (values: readonly number[]): readonly SelectOption[] =>
  values.map((n) => ({ value: String(n), label: String(n) }));

// --- the machine catalogues ------------------------------------------------

export const AWS_INSTANCE_TYPES = grouped(AWS_INSTANCE_TYPE_GROUPS);
export const AWS_DB_INSTANCE_CLASSES = grouped(AWS_DB_INSTANCE_CLASS_GROUPS);
export const AZURE_VM_SIZES = grouped(AZURE_VM_SIZE_GROUPS);
export const GCP_MACHINE_TYPES = grouped(GCP_MACHINE_TYPE_GROUPS);
export const OCI_SHAPES = grouped(OCI_SHAPE_GROUPS);

/** App Service SKUs. learn.microsoft.com/azure/app-service/overview-hosting-plans */
export const AZURE_APP_SERVICE_SKUS: readonly SelectOption[] = [
  ...under('Free and shared', ['F1', 'D1']),
  ...under('Basic', ['B1', 'B2', 'B3']),
  ...under('Standard', ['S1', 'S2', 'S3']),
  ...under('Premium v3', ['P0v3', 'P1v3', 'P2v3', 'P3v3', 'P1mv3', 'P2mv3', 'P3mv3', 'P4mv3', 'P5mv3']),
  ...under('Premium v2', ['P1v2', 'P2v2', 'P3v2']),
  ...under('Isolated v2', ['I1v2', 'I2v2', 'I3v2']),
  ...under('Functions', ['Y1', 'EP1', 'EP2', 'EP3']),
];

/** Cloud SQL tiers: shared-core, the custom ladder, then the legacy n1 ones. */
export const GCP_DB_TIERS: readonly SelectOption[] = [
  ...under('Shared core', ['db-f1-micro', 'db-g1-small']),
  ...under('Custom', [
    'db-custom-1-3840', 'db-custom-2-7680', 'db-custom-4-15360', 'db-custom-8-30720',
    'db-custom-16-61440', 'db-custom-32-122880', 'db-custom-64-245760', 'db-custom-96-368640',
  ]),
  ...under('Standard (legacy)', [
    'db-n1-standard-1', 'db-n1-standard-2', 'db-n1-standard-4',
    'db-n1-standard-8', 'db-n1-standard-16', 'db-n1-standard-32', 'db-n1-standard-64',
  ]),
  ...under('High memory (legacy)', [
    'db-n1-highmem-2', 'db-n1-highmem-4', 'db-n1-highmem-8',
    'db-n1-highmem-16', 'db-n1-highmem-32', 'db-n1-highmem-64',
  ]),
];

// --- where things run ------------------------------------------------------

/**
 * Availability domains are per-tenancy — the `Uocm:` prefix differs between
 * accounts — so these are the shape of the answer rather than the answer, and
 * the field stays a combo.
 */
export const OCI_AVAILABILITY_DOMAINS = [
  'Uocm:PHX-AD-1', 'Uocm:PHX-AD-2', 'Uocm:PHX-AD-3',
  'Uocm:US-ASHBURN-AD-1', 'Uocm:US-ASHBURN-AD-2', 'Uocm:US-ASHBURN-AD-3',
  'Uocm:EU-FRANKFURT-1-AD-1', 'Uocm:EU-FRANKFURT-1-AD-2', 'Uocm:EU-FRANKFURT-1-AD-3',
  'Uocm:UK-LONDON-1-AD-1', 'Uocm:UK-LONDON-1-AD-2', 'Uocm:UK-LONDON-1-AD-3',
];

/** Private ranges, the usual per-subnet carve-ups, and the one that means everything. */
export const COMMON_CIDRS = [
  '10.0.0.0/16', '10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24',
  '10.10.0.0/16', '10.20.0.0/16', '10.30.0.0/16', '10.40.0.0/16', '10.50.0.0/16',
  '10.100.0.0/16', '10.200.0.0/16',
  '172.16.0.0/16', '172.16.1.0/24', '172.31.0.0/16',
  '192.168.0.0/16', '192.168.1.0/24',
  '10.0.0.0/8', '172.16.0.0/12', '0.0.0.0/0',
  // IPv6: documentation, a /64 LAN, unique local, and the one that means everything.
  '2001:db8::/32', '2001:db8:0:1::/64', 'fd00::/8', '::/0',
];

// --- images ----------------------------------------------------------------

/**
 * AMI ids are per-region, so the only portable answer is an SSM public
 * parameter. Terraform's `aws_instance.ami` and the AWS modules both resolve a
 * `resolve:ssm:` alias, which is what makes these usable where a literal
 * `ami-0abc…` copied from another region is not.
 * docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-public-parameters-ami.html
 */
export const AWS_AMI_ALIASES: readonly SelectOption[] = [
  { value: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64', label: 'Amazon Linux 2023 (x86_64)', group: 'Amazon Linux' },
  { value: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64', label: 'Amazon Linux 2023 (arm64)', group: 'Amazon Linux' },
  { value: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/amzn2-ami-kernel-5.10-hvm-x86_64-gp2', label: 'Amazon Linux 2 (x86_64)', group: 'Amazon Linux' },
  { value: 'resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id', label: 'Ubuntu 24.04 LTS (amd64)', group: 'Ubuntu' },
  { value: 'resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id', label: 'Ubuntu 24.04 LTS (arm64)', group: 'Ubuntu' },
  { value: 'resolve:ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id', label: 'Ubuntu 22.04 LTS (amd64)', group: 'Ubuntu' },
  { value: 'resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base', label: 'Windows Server 2025', group: 'Windows Server' },
  { value: 'resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base', label: 'Windows Server 2022', group: 'Windows Server' },
  { value: 'resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2022-English-Core-Base', label: 'Windows Server 2022 Core', group: 'Windows Server' },
  { value: 'resolve:ssm:/aws/service/ami-windows-latest/Windows_Server-2019-English-Full-Base', label: 'Windows Server 2019', group: 'Windows Server' },
];

/** docs.cloud.google.com/compute/docs/images/os-details */
export const GCP_IMAGE_PROJECTS = [
  'debian-cloud', 'ubuntu-os-cloud', 'ubuntu-os-pro-cloud',
  'rocky-linux-cloud', 'almalinux-cloud', 'centos-cloud',
  'rhel-cloud', 'rhel-sap-cloud', 'oracle-linux-cloud',
  'suse-cloud', 'suse-sap-cloud', 'suse-byos-cloud', 'opensuse-cloud',
  'fedora-cloud', 'fedora-coreos-cloud', 'cos-cloud',
  'windows-cloud', 'windows-sql-cloud',
  'deeplearning-platform-release', 'ml-images',
];

/** docs.cloud.google.com/compute/docs/images/os-details */
export const GCP_IMAGE_FAMILIES: readonly SelectOption[] = [
  ...under('Debian', ['debian-13', 'debian-13-arm64', 'debian-12', 'debian-12-arm64', 'debian-11']),
  ...under('Ubuntu', [
    'ubuntu-2404-lts-amd64', 'ubuntu-2404-lts-arm64', 'ubuntu-2204-lts', 'ubuntu-2204-lts-arm64',
    'ubuntu-2004-lts', 'ubuntu-minimal-2404-lts-amd64', 'ubuntu-pro-2404-lts-amd64', 'ubuntu-pro-2204-lts',
  ]),
  ...under('RHEL', ['rhel-10', 'rhel-10-arm64', 'rhel-9', 'rhel-9-arm64', 'rhel-9-lvm', 'rhel-8', 'rhel-8-lvm']),
  ...under('Rocky Linux', [
    'rocky-linux-10', 'rocky-linux-9', 'rocky-linux-9-arm64',
    'rocky-linux-9-optimized-gcp', 'rocky-linux-8', 'rocky-linux-8-optimized-gcp',
  ]),
  ...under('AlmaLinux', ['almalinux-10', 'almalinux-9', 'almalinux-9-arm64', 'almalinux-8']),
  ...under('CentOS Stream', ['centos-stream-10', 'centos-stream-9', 'centos-stream-9-arm64']),
  ...under('Oracle Linux', ['oracle-linux-10', 'oracle-linux-9', 'oracle-linux-9-arm64', 'oracle-linux-8']),
  ...under('SUSE', ['sles-15', 'sles-15-arm64', 'sles-12', 'opensuse-leap-15-6']),
  ...under('Windows Server', [
    'windows-2025', 'windows-2025-core', 'windows-2022', 'windows-2022-core',
    'windows-2019', 'windows-2019-core', 'windows-2016',
  ]),
  ...under('Container-Optimized', ['cos-121-lts', 'cos-117-lts', 'cos-113-lts', 'cos-109-lts', 'fedora-coreos-stable']),
];

// --- runtimes --------------------------------------------------------------

/** The `Runtime` enum in the Lambda API model that ships with botocore, read 2026-09-20. */
export const AWS_LAMBDA_RUNTIMES: readonly SelectOption[] = [
  ...under('Node.js', ['nodejs22.x', 'nodejs20.x', 'nodejs18.x', 'nodejs16.x', 'nodejs14.x']),
  ...under('Python', ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3.8']),
  ...under('Java', ['java21', 'java17', 'java11', 'java17.al2023', 'java11.al2023', 'java8.al2']),
  ...under('.NET', ['dotnet8', 'dotnet6']),
  ...under('Ruby', ['ruby3.4', 'ruby3.3', 'ruby3.2']),
  ...under('Custom and Go', ['provided.al2023', 'provided.al2', 'go1.x']),
];

/** docs.cloud.google.com/functions/docs/runtime-support */
export const GCP_FUNCTION_RUNTIMES: readonly SelectOption[] = [
  ...under('Node.js', ['nodejs22', 'nodejs20', 'nodejs18', 'nodejs16']),
  ...under('Python', ['python313', 'python312', 'python311', 'python310', 'python39']),
  ...under('Go', ['go123', 'go122', 'go121', 'go120']),
  ...under('Java', ['java21', 'java17', 'java11']),
  ...under('.NET', ['dotnet8', 'dotnet6']),
  ...under('Ruby', ['ruby33', 'ruby32', 'ruby30']),
  ...under('PHP', ['php83', 'php82', 'php81']),
];

/**
 * App Service `linux_fx_version`, which is `RUNTIME|VERSION` and is rejected
 * whole if either half is wrong — exactly the field that should not be a text
 * box. learn.microsoft.com/azure/app-service/configure-language-dotnetcore etc.
 */
export const AZURE_RUNTIME_STACKS: readonly SelectOption[] = [
  ...under('.NET', ['DOTNETCORE|9.0', 'DOTNETCORE|8.0', 'DOTNETCORE|7.0', 'DOTNETCORE|6.0', 'DOTNETCORE|3.1']),
  ...under('Node.js', ['NODE|22-lts', 'NODE|20-lts', 'NODE|18-lts', 'NODE|16-lts']),
  ...under('Python', ['PYTHON|3.13', 'PYTHON|3.12', 'PYTHON|3.11', 'PYTHON|3.10', 'PYTHON|3.9', 'PYTHON|3.8']),
  ...under('Java SE', ['JAVA|21-java21', 'JAVA|17-java17', 'JAVA|11-java11', 'JAVA|8-jre8']),
  ...under('Tomcat', ['TOMCAT|10.1-java21', 'TOMCAT|10.0-java17', 'TOMCAT|9.0-java17', 'TOMCAT|9.0-java11', 'TOMCAT|8.5-java11']),
  ...under('JBoss EAP', ['JBOSSEAP|8-java17', 'JBOSSEAP|7.4-java11']),
  ...under('PHP', ['PHP|8.3', 'PHP|8.2', 'PHP|8.1', 'PHP|8.0']),
  ...under('Other', ['RUBY|2.7', 'GO|1.19']),
];

// --- versions --------------------------------------------------------------

/**
 * One field, several engines. RDS takes whichever version belongs to the engine
 * chosen a couple of boxes up, so the list is headed by engine rather than
 * filtered by it — a wrong pairing is then visibly wrong on the form instead of
 * at apply time.
 */
export const DB_ENGINE_VERSIONS: readonly SelectOption[] = [
  ...under('PostgreSQL', ['17', '17.4', '16', '16.8', '15', '15.12', '14', '14.17', '13', '13.20']),
  ...under('MySQL', ['8.4', '8.4.4', '8.0', '8.0.41', '5.7.44']),
  ...under('MariaDB', ['11.4', '11.4.5', '10.11', '10.11.11', '10.6.21']),
  ...under('Oracle', ['21.0.0.0.ru-2025-01.rur-2025-01.r1', '19.0.0.0.ru-2025-01.rur-2025-01.r1']),
  ...under('SQL Server', ['16.00.4185.3.v1', '15.00.4420.2.v1', '14.00.3465.1.v1']),
];

/** Cloud SQL `database_version`, which is its own spelling of the same thing. */
export const GCP_DB_VERSIONS: readonly SelectOption[] = [
  ...under('PostgreSQL', ['POSTGRES_17', 'POSTGRES_16', 'POSTGRES_15', 'POSTGRES_14', 'POSTGRES_13']),
  ...under('MySQL', ['MYSQL_8_4', 'MYSQL_8_0', 'MYSQL_5_7']),
  ...under('SQL Server', [
    'SQLSERVER_2022_STANDARD', 'SQLSERVER_2022_ENTERPRISE',
    'SQLSERVER_2019_STANDARD', 'SQLSERVER_2019_ENTERPRISE',
  ]),
];

/** RDS `engine`. docs.aws.amazon.com/AmazonRDS/latest/APIReference — CreateDBInstance. */
export const RDS_ENGINES = [
  'postgres', 'mysql', 'mariadb',
  'aurora-postgresql', 'aurora-mysql',
  'oracle-ee', 'oracle-ee-cdb', 'oracle-se2', 'oracle-se2-cdb',
  'sqlserver-ee', 'sqlserver-se', 'sqlserver-ex', 'sqlserver-web',
  'db2-ae', 'db2-se',
];

export const KUBERNETES_VERSIONS = ['v1.33.1', 'v1.32.4', 'v1.31.7', 'v1.30.11', 'v1.29.14'];

// --- storage ---------------------------------------------------------------

/** The `StorageClass` enum in the S3 API model that ships with botocore, read 2026-09-20. */
export const S3_STORAGE_CLASSES: readonly SelectOption[] = described({
  STANDARD: 'frequent access',
  INTELLIGENT_TIERING: 'moves itself between tiers',
  STANDARD_IA: 'infrequent access',
  ONEZONE_IA: 'infrequent access, one AZ',
  GLACIER_IR: 'archive, instant retrieval',
  GLACIER: 'archive, minutes to hours',
  DEEP_ARCHIVE: 'archive, up to 12 hours',
  EXPRESS_ONEZONE: 'single-digit ms, one AZ',
  REDUCED_REDUNDANCY: 'legacy, not recommended',
});

/** The `VolumeType` enum in the EC2 API model that ships with botocore, read 2026-09-20. */
export const EBS_VOLUME_TYPES: readonly SelectOption[] = described({
  gp3: 'general purpose SSD',
  gp2: 'general purpose SSD, previous',
  io2: 'provisioned IOPS SSD',
  io1: 'provisioned IOPS SSD, previous',
  st1: 'throughput HDD',
  sc1: 'cold HDD',
  standard: 'magnetic, previous generation',
});

/** learn.microsoft.com/azure/virtual-machines/disks-types */
export const AZURE_DISK_TYPES: readonly SelectOption[] = described({
  Premium_LRS: 'premium SSD',
  PremiumV2_LRS: 'premium SSD v2',
  Premium_ZRS: 'premium SSD, zone redundant',
  StandardSSD_LRS: 'standard SSD',
  StandardSSD_ZRS: 'standard SSD, zone redundant',
  Standard_LRS: 'standard HDD',
  UltraSSD_LRS: 'ultra disk',
});

/** docs.cloud.google.com/compute/docs/disks */
export const GCP_DISK_TYPES: readonly SelectOption[] = described({
  'pd-balanced': 'balanced persistent disk',
  'pd-ssd': 'SSD persistent disk',
  'pd-standard': 'standard persistent disk',
  'pd-extreme': 'extreme persistent disk',
  'hyperdisk-balanced': 'hyperdisk, balanced',
  'hyperdisk-extreme': 'hyperdisk, extreme',
  'hyperdisk-throughput': 'hyperdisk, throughput',
  'hyperdisk-ml': 'hyperdisk, ML',
});

export const GCP_STORAGE_CLASSES: readonly SelectOption[] = described({
  STANDARD: 'frequent access',
  NEARLINE: 'once a month or less',
  COLDLINE: 'once a quarter or less',
  ARCHIVE: 'once a year or less',
});

export const OCI_STORAGE_TIERS: readonly SelectOption[] = described({
  Standard: 'frequent access',
  InfrequentAccess: 'infrequent access',
  Archive: 'archive',
});

// --- who -------------------------------------------------------------------

/** The default login each cloud's own images ship with, then the usual service accounts. */
export const LINUX_USERS = [
  'ec2-user', 'ubuntu', 'azureuser', 'opc', 'root',
  'centos', 'rocky', 'almalinux', 'debian', 'fedora', 'cloud-user', 'admin',
  'ansible', 'deploy',
];
export const WINDOWS_USERS = ['Administrator', 'svc_ansible', 'ansible', 'automation'];
export const VSPHERE_USERS = [
  'administrator@vsphere.local', 'automation@vsphere.local',
  'ansible@vsphere.local', 'terraform@vsphere.local', 'svc_automation@vsphere.local',
];

/** A database's own admin login, which is not a shell login and never `root` on RDS. */
export const DB_ADMIN_USERS = [
  'dbadmin', 'postgres', 'sqladmin', 'admin', 'awsuser', 'mysqladmin', 'sa',
];

export const LINUX_SHELLS = ['/bin/bash', '/bin/sh', '/bin/zsh', '/bin/dash', '/usr/sbin/nologin', '/bin/false'];

/** The local groups Windows ships with. Membership in these is what a playbook sets. */
export const WINDOWS_LOCAL_GROUPS = [
  'Users', 'Administrators', 'Remote Desktop Users', 'Remote Management Users',
  'Power Users', 'Backup Operators', 'Guests', 'Performance Monitor Users',
  'Event Log Readers', 'Distributed COM Users', 'IIS_IUSRS',
];

/** Inventory patterns, plus the two that need no inventory at all. */
export const HOST_PATTERNS = [
  'all', 'localhost', 'linux', 'windows',
  'webservers', 'appservers', 'dbservers', 'loadbalancers',
  'prod', 'nonprod', 'dev', 'test', 'stage',
  'vmware', 'aws', 'azure', 'gcp', 'oci',
];

/** Where a key normally sits, per tool. Still a path, so still typeable. */
export const KEY_PATHS = [
  '~/.ssh/id_ed25519', '~/.ssh/id_rsa',
  '~/.oci/oci_api_key.pem',
  '~/.ssh/terraform', '~/.ssh/ansible',
];

// --- closed sets -----------------------------------------------------------

const YES_NO: readonly SelectOption[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const SSE_ALGORITHMS: readonly SelectOption[] = [
  { value: 'aws:kms', label: 'aws:kms — KMS managed key' },
  { value: 'aws:kms:dsse', label: 'aws:kms:dsse — dual-layer KMS' },
  { value: 'AES256', label: 'AES256 — S3 managed key' },
];

const PROTOCOLS: readonly SelectOption[] = [
  { value: 'tcp', label: 'tcp' },
  { value: 'udp', label: 'udp' },
  { value: 'icmp', label: 'icmp' },
  { value: 'all', label: 'all' },
];

const STATES: readonly SelectOption[] = [
  { value: 'present', label: 'present' },
  { value: 'absent', label: 'absent' },
];

/** Ports worth naming. Anything else still types fine. */
const PORTS: readonly SelectOption[] = described({
  '22': 'SSH',
  '25': 'SMTP',
  '53': 'DNS',
  '80': 'HTTP',
  '389': 'LDAP',
  '443': 'HTTPS',
  '445': 'SMB',
  '636': 'LDAPS',
  '1433': 'SQL Server',
  '1521': 'Oracle',
  '3306': 'MySQL and MariaDB',
  '3389': 'RDP',
  '5432': 'PostgreSQL',
  '5672': 'AMQP',
  '5985': 'WinRM over HTTP',
  '5986': 'WinRM over HTTPS',
  '6379': 'Redis',
  '8080': 'HTTP, alternate',
  '8443': 'HTTPS, alternate',
  '9092': 'Kafka',
  '9200': 'Elasticsearch',
  '27017': 'MongoDB',
});

/** Cron, which nobody reads correctly the first time. */
const CRON_SCHEDULES: readonly SelectOption[] = [
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '0 * * * *', label: 'Hourly, on the hour' },
  { value: '0 */4 * * *', label: 'Every 4 hours' },
  { value: '0 2 * * *', label: 'Daily at 02:00' },
  { value: '30 3 * * *', label: 'Daily at 03:30' },
  { value: '0 2 * * 0', label: 'Weekly, Sunday 02:00' },
  { value: '0 2 * * 6', label: 'Weekly, Saturday 02:00' },
  { value: '0 3 1 * *', label: 'Monthly, the 1st at 03:00' },
  { value: '@reboot', label: 'At boot' },
];

/**
 * The update categories win_updates accepts. Closed, and getting one wrong
 * fails the task rather than quietly installing nothing.
 * docs.ansible.com/ansible/latest/collections/ansible/windows/win_updates_module.html
 */
const WINDOWS_UPDATE_CATEGORIES: readonly SelectOption[] = [
  { value: 'SecurityUpdates,CriticalUpdates', label: 'Security and critical only' },
  { value: 'SecurityUpdates,CriticalUpdates,UpdateRollups', label: 'Security, critical and rollups' },
  { value: 'SecurityUpdates', label: 'SecurityUpdates' },
  { value: 'CriticalUpdates', label: 'CriticalUpdates' },
  { value: 'DefinitionUpdates', label: 'DefinitionUpdates' },
  { value: 'UpdateRollups', label: 'UpdateRollups' },
  { value: 'Updates', label: 'Updates' },
  { value: 'FeaturePacks', label: 'FeaturePacks' },
  { value: 'ServicePacks', label: 'ServicePacks' },
  { value: 'Tools', label: 'Tools' },
  { value: 'Drivers', label: 'Drivers' },
  { value: 'Application', label: 'Application' },
  { value: '*', label: 'Everything' },
];

/**
 * A password field offers references, not passwords.
 *
 * The originals ship `ChangeMe123!` as the default, which is how a literal
 * credential ends up committed. The generators already flag a literal as an
 * error finding; this puts the right answer in the box before that happens.
 * "Other" still accepts a literal, for anyone who insists.
 *
 * The Terraform entries are bare `var.` references rather than quoted strings,
 * which works because the emitted HCL is lifted afterwards — see
 * terraform/secrets.ts, which unquotes them and declares each one `sensitive`.
 */
const TERRAFORM_SECRETS: readonly SelectOption[] = under('Terraform variable', [
  'var.db_password', 'var.admin_password', 'var.vsphere_password', 'var.windows_password',
]);

const ANSIBLE_SECRETS: readonly SelectOption[] = [
  ...under('Ansible Vault', ['{{ vault_db_password }}', '{{ vault_admin_password }}', '{{ vault_windows_password }}']),
  ...under('Environment', [
    "{{ lookup('env', 'DB_PASSWORD') }}",
    "{{ lookup('env', 'ADMIN_PASSWORD') }}",
    "{{ lookup('env', 'VMWARE_PASSWORD') }}",
  ]),
];

// --- rules -----------------------------------------------------------------

/**
 * Which generator a rule is for.
 *
 * Most answers are the same either way — an instance type is an instance type.
 * Credentials are not: Terraform wants `var.db_password` and Ansible wants
 * `{{ vault_db_password }}`, and the two platforms that emit both (vSphere,
 * Linux, Windows) share a target id, so the target alone cannot tell them
 * apart. A rule left without a kind applies to both.
 */
export type GeneratorKind = 'terraform' | 'ansible';

interface Rule {
  /** Matches the input id. */
  readonly match: RegExp;
  /** Limit the rule to one platform when the answers differ per platform. */
  readonly target?: string;
  /** Limit the rule to one generator when the answers differ between them. */
  readonly kind?: GeneratorKind;
  readonly control: 'select' | 'combo';
  readonly options: readonly SelectOption[];
}

/**
 * First match wins, so the platform-specific rules come before the general
 * ones and the specific ids before the patterns.
 */
const RULES: readonly Rule[] = [
  // --- credentials, before any pattern below could claim them -------------
  // Anchored at the end so `allow_password_auth`, which is a yes/no, is not
  // offered a list of vault references.
  { match: /password$|secret_value$|_secret$/, kind: 'terraform', control: 'combo', options: TERRAFORM_SECRETS },
  { match: /password$|secret_value$|_secret$/, kind: 'ansible', control: 'combo', options: ANSIBLE_SECRETS },
  { match: /private_key_path|key_file|_key_path$/, control: 'combo', options: opts(KEY_PATHS) },

  // --- where things run --------------------------------------------------
  { match: /^hosts$/, control: 'combo', options: opts(HOST_PATTERNS) },

  { match: /(^|_)(region|location)$/, target: 'aws', control: 'select', options: opts(AWS_REGIONS) },
  { match: /(^|_)(region|location)$/, target: 'azure', control: 'select', options: opts(AZURE_REGIONS) },
  { match: /(^|_)zone$/, target: 'google', control: 'select', options: opts(GCP_ZONES) },
  { match: /(^|_)(region|location)$/, target: 'google', control: 'select', options: opts(GCP_REGIONS) },
  { match: /(^|_)(region|location)$/, target: 'oci', control: 'select', options: opts(OCI_REGIONS) },
  { match: /availability_domain/, target: 'oci', control: 'combo', options: opts(OCI_AVAILABILITY_DOMAINS) },

  // --- how big -----------------------------------------------------------
  { match: /instance_class/, target: 'aws', control: 'combo', options: AWS_DB_INSTANCE_CLASSES },
  { match: /^(instance_type|node_instance_type|machine_type)$/, target: 'aws', control: 'combo', options: AWS_INSTANCE_TYPES },
  { match: /^sku$|service_plan_sku|app_service_sku|plan_sku/, target: 'azure', control: 'combo', options: AZURE_APP_SERVICE_SKUS },
  { match: /^(vm_size|node_vm_size|sku_size|agents_size|machine_type|instance_type)$/, target: 'azure', control: 'combo', options: AZURE_VM_SIZES },
  { match: /db_tier|^tier$/, target: 'google', control: 'combo', options: GCP_DB_TIERS },
  { match: /^(machine_type|node_machine_type)$/, target: 'google', control: 'combo', options: GCP_MACHINE_TYPES },
  { match: /^shape$|shape_name/, target: 'oci', control: 'combo', options: OCI_SHAPES },

  // --- images ------------------------------------------------------------
  { match: /image_project/, target: 'google', control: 'combo', options: opts(GCP_IMAGE_PROJECTS) },
  { match: /image_family/, target: 'google', control: 'combo', options: GCP_IMAGE_FAMILIES },
  { match: /ami_id|^ami$/, target: 'aws', control: 'combo', options: AWS_AMI_ALIASES },

  // --- runtimes ----------------------------------------------------------
  { match: /runtime_stack|linux_fx_version/, target: 'azure', control: 'combo', options: AZURE_RUNTIME_STACKS },
  { match: /^runtime$/, target: 'google', control: 'combo', options: GCP_FUNCTION_RUNTIMES },
  { match: /^runtime$/, target: 'aws', control: 'combo', options: AWS_LAMBDA_RUNTIMES },

  // --- versions ----------------------------------------------------------
  // Each service spells a Kubernetes version its own way, and a wrong spelling
  // is rejected: EKS and AKS want "1.31", GKE also takes "latest", OKE wants "v1.31.1".
  { match: /k8s_version|kubernetes_version|cluster_version/, target: 'aws', control: 'combo', options: opts(['1.33', '1.32', '1.31', '1.30', '1.29']) },
  { match: /k8s_version|kubernetes_version/, target: 'azure', control: 'combo', options: opts(['1.33', '1.32', '1.31', '1.30']) },
  { match: /k8s_version|kubernetes_version/, target: 'google', control: 'combo', options: opts(['latest', '1.33', '1.32', '1.31', '1.30']) },
  { match: /k8s_version|kubernetes_version/, control: 'combo', options: opts(KUBERNETES_VERSIONS) },
  { match: /db_version|database_version/, target: 'google', control: 'combo', options: GCP_DB_VERSIONS },
  { match: /^engine$/, target: 'aws', control: 'combo', options: opts(RDS_ENGINES) },
  { match: /engine_version/, control: 'combo', options: DB_ENGINE_VERSIONS },

  // --- storage -----------------------------------------------------------
  { match: /storage_class/, target: 'aws', control: 'select', options: S3_STORAGE_CLASSES },
  { match: /storage_class/, target: 'google', control: 'select', options: GCP_STORAGE_CLASSES },
  { match: /storage_tier|^tier$/, target: 'oci', control: 'select', options: OCI_STORAGE_TIERS },
  { match: /volume_type|root_volume_type|ebs_type/, target: 'aws', control: 'select', options: EBS_VOLUME_TYPES },
  { match: /disk_type|storage_account_type|managed_disk_type/, target: 'azure', control: 'select', options: AZURE_DISK_TYPES },
  { match: /disk_type|boot_disk_type/, target: 'google', control: 'select', options: GCP_DISK_TYPES },

  // --- networks ----------------------------------------------------------
  { match: /cidr|(^|_)address_prefix$|_subnet_prefix$|^address_space$/, control: 'combo', options: opts(COMMON_CIDRS) },
  { match: /network_name|subnet_name|subnetwork|^network$/, target: 'google', control: 'combo', options: opts(['default']) },
  { match: /vm_network|network_label|^portgroup$/, target: 'vsphere', control: 'combo', options: opts(['VM Network', 'Management Network']) },

  // --- who ---------------------------------------------------------------
  { match: /vcenter_username|vsphere_user/, control: 'combo', options: opts(VSPHERE_USERS) },
  { match: /master_username|db_username|administrator_login|admin_login/, control: 'combo', options: opts(DB_ADMIN_USERS) },
  { match: /^shell$|login_shell/, control: 'select', options: opts(LINUX_SHELLS) },
  { match: /^group$|^groups$/, target: 'windows', control: 'combo', options: opts(WINDOWS_LOCAL_GROUPS) },
  { match: /^user$|username$|^admin_user/, target: 'windows', control: 'combo', options: opts(WINDOWS_USERS) },
  { match: /^user$|username$|^admin_user/, control: 'combo', options: opts(LINUX_USERS) },

  // --- closed sets -------------------------------------------------------
  { match: /sse_algorithm|encryption_algorithm/, control: 'select', options: SSE_ALGORITHMS },
  { match: /^protocol$/, control: 'select', options: PROTOCOLS },
  { match: /^state$/, control: 'select', options: STATES },
  { match: /category_names|update_categories/, target: 'windows', control: 'combo', options: WINDOWS_UPDATE_CATEGORIES },
  { match: /site_name/, target: 'windows', control: 'combo', options: opts(['Default Web Site']) },
  { match: /^schedule$|cron/, control: 'combo', options: CRON_SCHEDULES },

  // --- numbers with a known ladder ---------------------------------------
  { match: /storage_size_in_tbs|size_in_tbs/, control: 'select', options: counts([1, 2, 4, 8, 16, 32, 64, 128]) },
  { match: /memory_in_gbs|memory_gb|ram_gb/, control: 'select', options: counts([1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512]) },
  { match: /memory_mb/, control: 'select', options: counts([1024, 2048, 4096, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 131072]) },
  { match: /disk_gb|disk_size|storage_gb|allocated_storage|volume_size/, control: 'combo', options: counts([20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 4000, 8000, 16000]) },
  // Blank is a real answer here — it is what lets vSphere pick the next free
  // unit — so it leads the list rather than being the absence of one.
  { match: /^unit_number$/, target: 'vsphere', control: 'select', options: [
    { value: '', label: 'Next free unit' },
    ...counts([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15]),
  ] },
  { match: /(^|_)port$/, control: 'combo', options: PORTS },
  { match: /node_count|instance_count|^count$|replica_count/, control: 'select', options: counts([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20]) },
  { match: /^ocpus$|cpu_core_count|cpu_count|^vcpus?$|^cpus?$|num_cpus/, control: 'select', options: counts([1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64]) },
  { match: /evaluation_periods/, control: 'select', options: counts([1, 2, 3, 4, 5, 6, 10]) },
  { match: /^threshold$/, control: 'combo', options: counts([50, 60, 70, 75, 80, 85, 90, 95]) },
  { match: /visibility_timeout|^timeout$/, control: 'combo', options: counts([30, 60, 120, 300, 600, 900, 3600, 43200]) },
  { match: /retention|_days$/, control: 'combo', options: counts([1, 3, 7, 14, 30, 60, 90, 180, 365, 730, 2555]) },
];

/** A default that is already in the list, or added to the front so it shows. */
function withDefault(options: readonly SelectOption[], current: unknown): readonly SelectOption[] {
  const value = current === undefined || current === null ? '' : String(current);
  if (value === '' || options.some((o) => o.value === value)) return options;
  return [{ value, label: value }, ...options];
}

/**
 * A boolean the originals expressed as the strings "true" and "false".
 *
 * Those want a Yes/No dropdown rather than a text box someone can type "yes"
 * into — which in YAML 1.1 is a different thing from `true`.
 */
function looksBoolean(input: BlueprintInput): boolean {
  const value = String(input.default ?? '');
  if (input.control === 'text') return value === 'true' || value === 'false';
  if (input.control !== 'select') return false;
  const values = (input.options ?? []).map((o) => o.value).sort();
  return values.length === 2 && values[0] === 'false' && values[1] === 'true';
}

/**
 * A default that is a placeholder rather than an answer.
 *
 * `ChangeMe123!` and `CHANGEME` are not values anyone wants, and carrying one
 * into a suggestion list would make it look like one. The field opens on the
 * rule's own first option instead.
 */
function looksPlaceholder(value: unknown): boolean {
  return /^(change[_ -]?me|changeme|xxx+|<|ami-x|ocid1\.\w+\.oc1\.\.x)/i.test(String(value ?? ''));
}

/** Existing options first, then the ones the rule adds, without duplicates. */
function merge(
  existing: readonly SelectOption[],
  added: readonly SelectOption[],
): readonly SelectOption[] {
  const seen = new Set(existing.map((o) => o.value));
  return [...existing, ...added.filter((o) => !seen.has(o.value))];
}

export function applyChoices(
  input: BlueprintInput,
  target: string,
  kind: GeneratorKind,
): BlueprintInput {
  if (looksBoolean(input)) {
    return { ...input, control: 'select', options: YES_NO };
  }

  // A textarea is for a list, a map or an object — a structure, not a value,
  // and no answer set of single values fits it.
  if (input.control === 'textarea') return input;

  for (const rule of RULES) {
    if (rule.target !== undefined && rule.target !== target) continue;
    if (rule.kind !== undefined && rule.kind !== kind) continue;
    if (!rule.match.test(input.id)) continue;

    /*
     * A blueprint that already declared a closed set is not overruled, it is
     * added to. The originals list a handful of instance types; the rule knows
     * all 1,428 of them. Replacing theirs would lose the ones they chose for a
     * reason, and ignoring the rule leaves a field offering six machines out of
     * hundreds. So both, theirs first.
     *
     * The one exception is a genuinely closed set the rule declares — a storage
     * class is one of nine things — where adding to it would offer a tenth that
     * the provider rejects.
     */
    if (input.control === 'select') {
      const existing = input.options ?? [];
      if (rule.control === 'select' || existing.length === 0) return input;
      return { ...input, control: 'combo', options: merge(existing, rule.options) };
    }

    const placeholder = looksPlaceholder(input.default);
    return {
      ...input,
      control: rule.control,
      default: placeholder ? (rule.options[0]?.value ?? input.default) : input.default,
      options: placeholder ? rule.options : withDefault(rule.options, input.default),
    };
  }
  return input;
}

/** Every input in a group, with its answer set attached. */
export function withChoices(group: BlueprintGroup, kind: GeneratorKind): BlueprintGroup {
  const blueprints: Blueprint[] = group.blueprints.map((blueprint) => ({
    ...blueprint,
    inputs: blueprint.inputs.map((input) => applyChoices(input, group.target, kind)),
  }));
  return { ...group, blueprints };
}

export function withChoicesAll(
  groups: readonly BlueprintGroup[],
  kind: GeneratorKind,
): readonly BlueprintGroup[] {
  return groups.map((group) => withChoices(group, kind));
}

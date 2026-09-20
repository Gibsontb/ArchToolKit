/**
 * Answer sets for the generator inputs.
 *
 * Almost every field on these forms has a known set of sensible answers, and a
 * text box for one of them just moves the error to plan time, where the message
 * names the argument rather than the value. So the rules here turn inputs into
 * dropdowns wherever an answer set exists.
 *
 * Two kinds, because two kinds of question exist:
 *
 *  - `select` where the set is genuinely closed. A storage replication type is
 *    one of six things; anything else is rejected by the provider, so offering
 *    a seventh would be a lie.
 *  - `combo` where the set is long, changes between releases, or is partly
 *    yours. An instance type, an image, a subnet CIDR. The dropdown suggests
 *    the common answers and still accepts anything typed, so it helps without
 *    getting in the way.
 *
 * The rules match on input id and platform rather than on a per-blueprint list,
 * so they apply to all of the blueprints at once and to any added later.
 */

                                                                                              
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, GCP_ZONES, OCI_REGIONS } from './regions.js';

const opts = (values                   )                          =>
  values.map((value) => ({ value, label: value }));

// --- answer sets ----------------------------------------------------------

/** EC2 sizes people actually pick. Not the full list; the box still takes one. */
export const AWS_INSTANCE_TYPES = [
  't3.nano', 't3.micro', 't3.small', 't3.medium', 't3.large', 't3.xlarge', 't3.2xlarge',
  'm5.large', 'm5.xlarge', 'm5.2xlarge', 'm5.4xlarge',
  'm6i.large', 'm6i.xlarge', 'm6i.2xlarge',
  'c5.large', 'c5.xlarge', 'c5.2xlarge',
  'c6i.large', 'c6i.xlarge',
  'r5.large', 'r5.xlarge', 'r5.2xlarge',
  'r6i.large', 'r6i.xlarge',
  'i4i.metal',
];

export const AWS_DB_INSTANCE_CLASSES = [
  'db.t3.micro', 'db.t3.small', 'db.t3.medium', 'db.t3.large',
  'db.m5.large', 'db.m5.xlarge', 'db.m5.2xlarge',
  'db.m6g.large', 'db.m6g.xlarge',
  'db.r5.large', 'db.r5.xlarge',
];

export const AZURE_VM_SIZES = [
  'Standard_B1s', 'Standard_B2s', 'Standard_B2ms', 'Standard_B4ms', 'Standard_B8ms',
  'Standard_D2s_v5', 'Standard_D4s_v5', 'Standard_D8s_v5', 'Standard_D16s_v5',
  'Standard_E2s_v5', 'Standard_E4s_v5', 'Standard_E8s_v5',
  'Standard_F2s_v2', 'Standard_F4s_v2', 'Standard_F8s_v2',
  'Standard_DS2_v2', 'Standard_DS3_v2',
];

export const GCP_MACHINE_TYPES = [
  'e2-micro', 'e2-small', 'e2-medium',
  'e2-standard-2', 'e2-standard-4', 'e2-standard-8',
  'n2-standard-2', 'n2-standard-4', 'n2-standard-8',
  'n2-highmem-2', 'n2-highmem-4',
  'c2-standard-4', 'c2-standard-8',
];

export const OCI_SHAPES = [
  'VM.Standard.E4.Flex', 'VM.Standard.E5.Flex', 'VM.Standard3.Flex',
  'VM.Standard.A1.Flex', 'VM.Optimized3.Flex',
  'VM.Standard2.1', 'VM.Standard2.2', 'VM.Standard2.4', 'VM.Standard2.8',
];

export const OCI_AVAILABILITY_DOMAINS = [
  'Uocm:PHX-AD-1', 'Uocm:PHX-AD-2', 'Uocm:PHX-AD-3',
  'Uocm:US-ASHBURN-AD-1', 'Uocm:US-ASHBURN-AD-2', 'Uocm:US-ASHBURN-AD-3',
];

export const AZURE_APP_SERVICE_SKUS = [
  'F1', 'D1', 'B1', 'B2', 'B3', 'S1', 'S2', 'S3', 'P1v3', 'P2v3', 'P3v3',
];

export const GCP_IMAGE_FAMILIES = [
  'debian-12', 'debian-11',
  'ubuntu-2404-lts-amd64', 'ubuntu-2204-lts', 'ubuntu-2004-lts',
  'rocky-linux-9', 'rocky-linux-8',
  'rhel-9', 'rhel-8',
  'centos-stream-9',
  'windows-2022', 'windows-2019',
];

/** Private ranges and the two that mean "everything". */
export const COMMON_CIDRS = [
  '10.0.0.0/16', '10.0.1.0/24', '10.0.2.0/24',
  '10.10.0.0/16', '10.20.0.0/16', '10.30.0.0/16', '10.40.0.0/16', '10.50.0.0/16',
  '172.16.0.0/16', '192.168.0.0/16',
  '10.0.0.0/8', '0.0.0.0/0',
];

export const LINUX_USERS = ['root', 'ec2-user', 'ubuntu', 'centos', 'opc', 'azureuser', 'admin', 'deploy'];
export const WINDOWS_USERS = ['Administrator', 'svc_ansible'];
export const VSPHERE_USERS = ['administrator@vsphere.local', 'automation@vsphere.local'];

export const POSTGRES_VERSIONS = ['17', '16', '15', '14', '13'];
export const KUBERNETES_VERSIONS = ['v1.31.1', 'v1.30.5', 'v1.29.9', 'v1.28.14'];

/** Inventory patterns, plus the two that need no inventory at all. */
export const HOST_PATTERNS = ['all', 'localhost', 'linux', 'windows', 'webservers', 'dbservers'];

const YES_NO                          = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const SSE_ALGORITHMS                          = [
  { value: 'aws:kms', label: 'aws:kms — KMS managed key' },
  { value: 'AES256', label: 'AES256 — S3 managed key' },
];

const PROTOCOLS                          = [
  { value: 'tcp', label: 'tcp' },
  { value: 'udp', label: 'udp' },
  { value: 'icmp', label: 'icmp' },
  { value: 'all', label: 'all' },
];

const STATES                          = [
  { value: 'present', label: 'present' },
  { value: 'absent', label: 'absent' },
];

const counts = (values                   )                          =>
  values.map((n) => ({ value: String(n), label: String(n) }));

// --- rules ----------------------------------------------------------------

                
                              
                         
                                                                             
                           
                                       
                                            
 

/**
 * First match wins, so the platform-specific rules come before the general
 * ones and the specific ids before the patterns.
 */
const RULES                  = [
  // --- where things run --------------------------------------------------
  { match: /^hosts$/, control: 'combo', options: opts(HOST_PATTERNS) },

  { match: /(^|_)(region|location)$/, target: 'aws', control: 'select', options: opts(AWS_REGIONS) },
  { match: /(^|_)(region|location)$/, target: 'azure', control: 'select', options: opts(AZURE_REGIONS) },
  { match: /(^|_)zone$/, target: 'google', control: 'select', options: opts(GCP_ZONES) },
  { match: /(^|_)(region|location)$/, target: 'google', control: 'select', options: opts(GCP_REGIONS) },
  { match: /(^|_)(region|location)$/, target: 'oci', control: 'select', options: opts(OCI_REGIONS) },
  { match: /availability_domain/, target: 'oci', control: 'combo', options: opts(OCI_AVAILABILITY_DOMAINS) },

  // --- how big -----------------------------------------------------------
  { match: /instance_class/, target: 'aws', control: 'combo', options: opts(AWS_DB_INSTANCE_CLASSES) },
  { match: /instance_type|_size$|^size$/, target: 'aws', control: 'combo', options: opts(AWS_INSTANCE_TYPES) },
  { match: /^sku$/, target: 'azure', control: 'combo', options: opts(AZURE_APP_SERVICE_SKUS) },
  { match: /vm_size|node_vm_size|_size$/, target: 'azure', control: 'combo', options: opts(AZURE_VM_SIZES) },
  { match: /machine_type/, target: 'google', control: 'combo', options: opts(GCP_MACHINE_TYPES) },
  { match: /db_tier/, target: 'google', control: 'combo', options: opts(['db-f1-micro', 'db-g1-small', 'db-custom-1-3840', 'db-custom-2-7680', 'db-custom-4-15360']) },
  { match: /^shape$/, target: 'oci', control: 'combo', options: opts(OCI_SHAPES) },

  // --- images ------------------------------------------------------------
  { match: /image_family/, target: 'google', control: 'combo', options: opts(GCP_IMAGE_FAMILIES) },

  // --- versions ----------------------------------------------------------
  { match: /k8s_version|kubernetes_version/, control: 'combo', options: opts(KUBERNETES_VERSIONS) },
  { match: /engine_version/, control: 'combo', options: opts(POSTGRES_VERSIONS) },

  // --- networks ----------------------------------------------------------
  { match: /cidr/, control: 'combo', options: opts(COMMON_CIDRS) },

  // --- who ---------------------------------------------------------------
  { match: /vcenter_username|vsphere_user/, control: 'combo', options: opts(VSPHERE_USERS) },
  { match: /^user$|username$/, target: 'windows', control: 'combo', options: opts(WINDOWS_USERS) },
  { match: /^user$|username$/, control: 'combo', options: opts(LINUX_USERS) },

  // --- closed sets -------------------------------------------------------
  { match: /sse_algorithm|encryption_algorithm/, control: 'select', options: SSE_ALGORITHMS },
  { match: /^protocol$/, control: 'select', options: PROTOCOLS },
  { match: /^state$/, control: 'select', options: STATES },

  // --- counts ------------------------------------------------------------
  { match: /node_count|instance_count|^count$/, control: 'select', options: counts([1, 2, 3, 4, 5, 6, 8, 10]) },
  { match: /^ocpus$|cpu_count|^vcpu/, control: 'select', options: counts([1, 2, 4, 8, 16, 32]) },
  { match: /memory_in_gbs/, control: 'select', options: counts([8, 16, 32, 64, 128, 256]) },
  { match: /memory_mb/, control: 'select', options: counts([2048, 4096, 8192, 16384, 32768, 65536]) },
];

/** A default that is already in the list, or added to the front so it shows. */
function withDefault(options                         , current         )                          {
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
function looksBoolean(input                )          {
  if (input.control !== 'text') return false;
  const value = String(input.default ?? '');
  return value === 'true' || value === 'false';
}

export function applyChoices(input                , target        )                 {
  // A blueprint that already declared a closed set knows better than a rule.
  if (input.control === 'select') return input;

  if (looksBoolean(input)) {
    return { ...input, control: 'select', options: YES_NO };
  }

  for (const rule of RULES) {
    if (rule.target !== undefined && rule.target !== target) continue;
    if (!rule.match.test(input.id)) continue;
    return {
      ...input,
      control: rule.control,
      options: withDefault(rule.options, input.default),
    };
  }
  return input;
}

/** Every input in a group, with its answer set attached. */
export function withChoices(group                )                 {
  const blueprints              = group.blueprints.map((blueprint) => ({
    ...blueprint,
    inputs: blueprint.inputs.map((input) => applyChoices(input, group.target)),
  }));
  return { ...group, blueprints };
}

export function withChoicesAll(groups                           )                            {
  return groups.map(withChoices);
}

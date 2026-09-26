/**
 * What the cloud server-path generators (WP-11c: aws-mgn, azure-migrate*,
 * gcp-m2vm, gcp-image-import, oci-ocm) share: where an item lands in the
 * target design, CSV and JSON rendering for the provider-format exports, and
 * the landing-zone keys the scripts resolve at run time.
 *
 * The scripts never carry a cloud id the generator cannot know (subnet,
 * security group, account): the generated files name the landing-zone key
 * (`@subnet prod/app/a`, `@sg prod/app`), and each script resolves it from
 * the Terraform outputs of its platform stack when it runs.
 *
 * Pure.
 */

import { licenceKeyOf, type LicenceHandlingKey } from '../../design/compute.ts';
import { networkZones } from '../../design/network.ts';
import { osKind } from '../../os.ts';
import type { ComputeTarget, NetworkDesign, Platform, PlatformDesign, Workload } from '../../types.ts';
import type { ManifestItem } from '../manifest.ts';
import type { PathContext } from '../registry.ts';

export const ZONE_LETTERS = ['a', 'b', 'c'] as const;

/** Where a server lands: the design's compute target, read for the scripts. */
export interface Placement {
  readonly platform: Platform;
  readonly region: string;
  readonly size: string;
  readonly vcpu: number;
  readonly ramGib: number;
  readonly ocpus?: number;
  readonly disks: readonly { readonly gib: number; readonly type: string }[];
  /** The landing-zone network (e.g. `prod`), its tier and zone letter: the keys of `subnet_ids` / `security_group_ids`. */
  readonly network: string;
  readonly tier: string;
  readonly zoneLetter: string;
  /** The zone name as the design has it (e.g. `us-east-1a`). */
  readonly zone: string;
  readonly zoneIndex: number;
  readonly ipv6: boolean;
  /** The network test launches go to: the first network without prod (A.6.1 settings: "the nonprod network"). */
  readonly testNetwork: string;
  readonly testIpv6: boolean;
  readonly licence: LicenceHandlingKey;
  readonly windows: boolean;
  readonly env: string;
  readonly workload?: Workload;
}

/** The design's placement of a workload item, or undefined when the design has none (a finding says so). */
export function placementOf(item: ManifestItem, ctx: PathContext): Placement | undefined {
  const platform = item.target.platform;
  const pd: PlatformDesign | undefined = ctx.design.platforms.find((p) => p.platform === platform);
  const c: ComputeTarget | undefined = pd?.compute.find((x) => x.workload === item.id);
  const workload = ctx.plan.workloads.find((w) => w.id === item.id);
  if (!platform || !pd || !c) return undefined;
  const net: NetworkDesign | undefined = pd.networks.find((n) => n.name === c.network);
  const zones = net ? networkZones(net) : [];
  const zi = Math.max(0, zones.indexOf(c.zone));
  const zoneIndex = zi < ZONE_LETTERS.length ? zi : 0;
  const test = pd.networks.find((n) => !n.envs.includes('prod')) ?? net;
  return {
    platform,
    region: pd.region,
    size: c.size,
    vcpu: c.vcpu,
    ramGib: c.ramGib,
    ...(c.ocpus !== undefined ? { ocpus: c.ocpus } : {}),
    disks: c.disks,
    network: c.network,
    tier: c.tier,
    zoneLetter: ZONE_LETTERS[zoneIndex] ?? 'a',
    zone: c.zone,
    zoneIndex,
    ipv6: net?.ipv6 ?? false,
    testNetwork: test?.name ?? c.network,
    testIpv6: test?.ipv6 ?? false,
    licence: licenceKeyOf(c, platform),
    windows: item.os ? osKind(item.os) === 'windows' : false,
    env: workload?.env ?? 'prod',
    ...(workload ? { workload } : {}),
  };
}

/** The subnet key of the landing-zone contract: `<network>/<tier>/<zone letter>`. */
export const subnetKey = (network: string, tier: string, zoneLetter: string): string => `${network}/${tier}/${zoneLetter}`;
/** The security-group key of the landing-zone contract: `<network>/<tier>`. */
export const sgKey = (network: string, tier: string): string => `${network}/${tier}`;

/** One CSV cell, quoted when it has to be (RFC 4180). */
export function csvCell(v: string | number | boolean | undefined | null): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** A CSV file: a header and rows, CRLF-free, ending in a newline. */
export function csvText(header: readonly string[], rows: readonly (readonly (string | number | boolean | undefined | null)[])[]): string {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}

/** Stable JSON, two-space indent, ending in a newline. */
export const jsonText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** The workload items with a wave, grouped by wave in wave order; unwaved items last under `null`. */
export function byWave(items: readonly ManifestItem[]): [number | null, ManifestItem[]][] {
  const m = new Map<number | null, ManifestItem[]>();
  for (const i of items) m.set(i.wave, [...(m.get(i.wave) ?? []), i]);
  return [...m.entries()].sort((a, b) => (a[0] ?? Number.MAX_SAFE_INTEGER) - (b[0] ?? Number.MAX_SAFE_INTEGER));
}

/** A lower-case name a cloud accepts for a VM: letters, digits, hyphens, starting with a letter, at most 63. */
export function vmName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const t = /^[a-z]/.test(s) ? s : `vm-${s}`;
  return t.slice(0, 63).replace(/-+$/, '') || 'vm';
}

/** Bash: the Terraform output of this platform's stack whose name is NAME or ends in _NAME (a stack prefixes each item's outputs). */
export const TF_OUTPUT_FN = `
# atk_tf_output DIR NAME: the value of the stack output NAME (or <item>_NAME, as a stack writes it), as JSON.
atk_tf_output() {
  local dir="$1" name="$2" all
  [[ -d "$dir" ]] || atk_die 5 "no Terraform stack at $dir: apply the platform stack first (or set the directory in the environment)"
  all="$(terraform -chdir="$dir" output -json)" || atk_die 5 "terraform output failed in $dir"
  jq -ce --arg n "$name" '[to_entries[] | select(.key == $n or (.key | endswith("_" + $n)))] | if length == 0 then error("no output " + $n) else .[0].value.value end' <<< "$all" \\
    || atk_die 5 "the stack in $dir has no $name output: add the replication item to the stack and apply it"
}

# atk_resolve LZJSON: stdin JSON with "@subnet <key>", "@sg <key>", "@network <name>" and "@instance_profile" strings resolved from LZJSON.
atk_resolve() {
  jq --argjson lz "$1" 'walk(if type == "string" and startswith("@") then
      (if startswith("@subnet ") then ($lz.subnet_ids[.[8:]] // error("no subnet " + .[8:] + " in the landing zone"))
       elif startswith("@sg ") then ($lz.security_group_ids[.[4:]] // error("no security group " + .[4:] + " in the landing zone"))
       elif startswith("@network ") then ($lz.network_ids[.[9:]] // error("no network " + .[9:] + " in the landing zone"))
       elif . == "@instance_profile" then ($lz.instance_profile // error("no instance profile in the landing zone"))
       else . end)
    else . end)'
}
`;

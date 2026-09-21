/**
 * Carrying a sizing result into the specification builder.
 *
 * The two tools already agree on the facts — host count, storage type, failures
 * to tolerate, how many addresses each pool needs — but until now a person had
 * to read them off one screen and retype them into another. Retyping is where
 * the numbers drift, and a spec whose pools disagree with the sizing that
 * justified them is worse than one built from scratch.
 *
 * This is deliberately a partial plan: sizing knows nothing about names, domains
 * or VLANs, and inventing them here would put guesses in front of the user as
 * though they were derived.
 */

import type { SizingResult, SizingInput } from './sizing.ts';
import type { DeploymentPlan, HostEntry, NetworkPlan } from './spec-builder.ts';
import { scopedKey, type Inventory, type InventoryHost, type VmkernelAdapter } from '../vmware/inventory.ts';
import { parseIPv4, formatIPv4, maskToPrefix } from '../core/net.ts';
import type { DeploymentScenario } from './scenarios.ts';

/** The deployment scenario a sizing path implies, where one does. */
export function scenarioForPath(path: SizingInput['path']): DeploymentScenario | undefined {
  switch (path) {
    case 'greenfield':
      return 'new-vcf-fleet';
    case 'brownfield-converge':
      return 'converge-to-vcf-fleet';
    // Importing an existing estate as a workload domain is a day-2 operation,
    // not a bring-up, so no bring-up scenario corresponds to it.
    case 'brownfield-import':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The part of a deployment plan a sizing result determines.
 *
 * Pool sizes are carried as counts rather than ranges: the builder allocates the
 * actual addresses from the subnets it is given, and it should keep doing that —
 * what sizing contributes is how many are needed.
 */
export function sizingToPlan(result: SizingResult): Partial<DeploymentPlan> {
  const { input } = result;
  const scenario = scenarioForPath(input.path);

  return {
    hostCount: input.hostCount,
    storage: input.storage,
    // The spec builder's profile is the HA split only; the sizing profile also
    // carries a scale, which maps to the appliance sizes instead.
    profile: input.profile === 'simple' ? 'simple' : 'ha',
    failuresToTolerate: result.storage.ftt,
    ...(scenario ? { scenario } : {}),
    ...(input.pnicsPerHost ? { pnicsPerHost: input.pnicsPerHost } : {}),
    ...(input.includeAutomation !== undefined
      ? { includeAutomation: input.includeAutomation }
      : {}),
    ...(input.automationSize ? { automationSize: input.automationSize } : {}),
    // Counts come from the sizing model so the emitted pools match the sizing
    // that justified them.
    vcfmsPool: { count: result.ips.vcfmsRecommended },
    automationPool: { count: result.ips.automationIps },
    tepPool: { count: result.ips.tepIps },
  };
}

/** A one-line description of what a sizing result contributes, for a banner. */
export function describeSizingHandoff(result: SizingResult): string {
  const { input } = result;
  const profile = input.profile === 'simple' ? 'simple' : 'HA';
  return `${input.hostCount} hosts, ${input.storage}, ${profile} profile, FTT ${result.storage.ftt}, ${result.ips.totalRecommended} addresses recommended`;
}

// ---------------------------------------------------------------------------
// From the imported estate
// ---------------------------------------------------------------------------

/**
 * What the estate itself says about a VCF bring-up.
 *
 * The hosts already know their DNS servers, NTP sources and domain, and the
 * cluster being converged already has a management, vMotion and vSAN network
 * with addresses, masks, gateways, MTUs and VLANs. RVTools recorded all of it
 * (vHost, vSC_VMK, vPort, dvPort), so the spec builder should start from it
 * rather than from example values.
 *
 * vMotion and vSAN VMkernel adapters are recognised by their port group's
 * name, because RVTools does not record which services a VMkernel adapter
 * carries. One that cannot be recognised is left for the person to fill in
 * rather than guessed.
 */
export function estateToPlan(inventory: Inventory, managementClusterKey?: string): Partial<DeploymentPlan> {
  const hosts = managementClusterKey
    ? inventory.hosts.filter((h) => scopedKey(h.vcenter, h.cluster ?? '(standalone)') === managementClusterKey)
    : [];
  const pool = hosts.length > 0 ? hosts : inventory.hosts;
  const plan: Record<string, unknown> = {};

  const dns = mostCommon(pool.map((h) => (h.dnsServers ?? []).slice(0, 2).join(',')).filter(Boolean));
  if (dns) plan.dnsServers = dns.split(',');
  const ntp = mostCommon(pool.map((h) => (h.ntpServers ?? []).join(',')).filter(Boolean));
  if (ntp) plan.ntpServers = ntp.split(',');
  const domain = mostCommon(pool.map((h) => (h.domain ?? '').toLowerCase()).filter(Boolean));
  if (domain) plan.domainSuffix = domain;

  if (hosts.length === 0) return plan as Partial<DeploymentPlan>;

  plan.hostCount = hosts.length;
  plan.hosts = hosts
    .map((h) => h.name.split('.')[0] ?? h.name)
    .sort()
    .map((hostname): HostEntry => ({ hostname }));

  const vlanOf = (host: InventoryHost, portGroup: string | undefined): number | undefined => {
    if (!portGroup) return undefined;
    const standard = host.portGroups?.find((p) => p.name === portGroup);
    const distributed = inventory.networks.find(
      (n) => n.kind === 'distributed' && n.name === portGroup && (n.vcenter ?? '') === (host.vcenter ?? ''),
    );
    const vlan = Number((standard ?? distributed)?.vlanId);
    return Number.isFinite(vlan) ? vlan : undefined;
  };

  const network = (match: (vmk: VmkernelAdapter) => boolean): NetworkPlan | undefined => {
    const found: { cidr: string; gateway?: string; mtu?: number; vlan?: number }[] = [];
    for (const host of hosts) {
      const vmk = (host.vmkernelAdapters ?? []).find(match);
      if (!vmk?.ip || !vmk.subnetMask) continue;
      const ip = parseIPv4(vmk.ip);
      const mask = parseIPv4(vmk.subnetMask);
      const prefix = mask === null ? null : maskToPrefix(mask);
      if (ip === null || mask === null || prefix === null) continue;
      // RVTools records the host's default gateway against every adapter; it
      // belongs to this network only when it sits inside it.
      const gw = vmk.gateway ? parseIPv4(vmk.gateway) : null;
      const inside = gw !== null && ((gw & mask) >>> 0) === ((ip & mask) >>> 0);
      found.push({
        cidr: `${formatIPv4((ip & mask) >>> 0)}/${prefix}`,
        ...(inside && vmk.gateway ? { gateway: vmk.gateway } : {}),
        ...(vmk.mtu ? { mtu: vmk.mtu } : {}),
        ...(vlanOf(host, vmk.portGroup) !== undefined ? { vlan: vlanOf(host, vmk.portGroup) } : {}),
      });
    }
    const cidr = mostCommon(found.map((f) => f.cidr));
    if (!cidr) return undefined;
    const same = found.filter((f) => f.cidr === cidr);
    const gateway = mostCommon(same.map((f) => f.gateway ?? '').filter(Boolean));
    const mtu = Number(mostCommon(same.map((f) => String(f.mtu ?? '')).filter(Boolean)));
    const vlan = Number(mostCommon(same.map((f) => String(f.vlan ?? '')).filter((v) => v !== '')));
    return {
      cidr,
      vlanId: Number.isFinite(vlan) ? vlan : 0,
      ...(gateway ? { gateway } : {}),
      ...(Number.isFinite(mtu) && mtu > 0 ? { mtu } : {}),
    };
  };

  // Named management port groups first — VxRail puts its own discovery
  // network on vmk0 — then vmk0 itself.
  const management =
    network((v) => /management network|(^|[_\-\s*])(mgmt|mgt)([_\-\s]|$)/i.test(v.portGroup ?? '') && !/vxrail|bmc/i.test(v.portGroup ?? '')) ??
    network((v) => v.name === 'vmk0');
  if (management) plan.management = management;
  const vmotion = network((v) => /vmotion|(^|[_\-\s.])vm[ot]($|[_\-\s.])/i.test(v.portGroup ?? ''));
  if (vmotion) plan.vmotion = vmotion;
  const vsan = network((v) => /vsan|virtual san/i.test(v.portGroup ?? ''));
  if (vsan) plan.vsan = vsan;
  const uplinks = mostCommon(hosts.map((h) => String((h.physicalNics ?? []).filter((n) => n.linkUp !== false).length)));
  if (uplinks && Number(uplinks) > 0) plan.pnicsPerHost = Number(uplinks);

  return plan as Partial<DeploymentPlan>;
}

function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

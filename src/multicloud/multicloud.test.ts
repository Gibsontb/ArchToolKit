import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { CATALOG_DATA } from '../terraform/catalog-data.ts';
import { PLATFORMS, platformInfo, isHyperscaler, type Platform } from './platforms.ts';
import { CAPABILITIES, serviceOn, gapsFor, commonCapabilities } from './services.ts';
import { VMWARE_CLOUD_SERVICES, vmwareCloudService, supportsVcfVersion } from './vmware-on-cloud.ts';
import { decide, type WorkloadProfile } from './decide.ts';
import { profileFromInventory } from './from-inventory.ts';
import { emptyInventory } from '../vmware/inventory.ts';
import type { Inventory, InventoryVm } from '../vmware/inventory.ts';

describe('multicloud/services: the table checks itself', () => {
  /**
   * The point of carrying Terraform resource types rather than only product
   * names: a name that gets renamed in a provider release fails here instead of
   * quietly becoming wrong.
   */
  it('names only resource types the provider catalog actually holds', () => {
    const have: Record<string, Set<string>> = {};
    for (const [target, entry] of Object.entries(CATALOG_DATA)) {
      const prefix = target === 'azure' ? 'azurerm_' : `${target}_`;
      have[target] = new Set(entry.resources.split(',').map((n) => prefix + n));
    }

    const missing: string[] = [];
    for (const row of CAPABILITIES) {
      for (const platform of PLATFORMS) {
        const service = row.on[platform];
        if (!service) continue;
        const target = platformInfo(platform).terraform;
        if (!have[target]?.has(service.terraformType)) {
          missing.push(`${row.capability}/${platform}: ${service.terraformType}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('covers a useful number of capabilities', () => {
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(20);
  });

  it('gives every capability an entry on at least two platforms', () => {
    // A row present on one platform is a product, not a capability comparison.
    for (const row of CAPABILITIES) {
      expect(Object.keys(row.on).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('reports a platform gap as a gap rather than an equivalent', () => {
    // vSphere has no managed Kubernetes in this table, and pretending otherwise
    // would be the whole failure mode of a matrix like this.
    expect(serviceOn('kubernetes', 'vmware')).toBeUndefined();
    expect(gapsFor('vmware')).toContain('kubernetes');
  });

  it('finds the capabilities a set of platforms share', () => {
    const shared = commonCapabilities(['aws', 'azure']);
    expect(shared).toContain('object-storage');
    expect(shared).toContain('kubernetes');
    expect(commonCapabilities([])).toEqual([]);
  });

  it('maps every platform onto a Terraform provider and an Ansible collection', () => {
    for (const platform of PLATFORMS) {
      const meta = platformInfo(platform);
      expect(meta.terraform.length).toBeGreaterThan(0);
      expect(meta.ansible.length).toBeGreaterThan(0);
    }
    // VCF on owned hardware is not a hyperscaler, and the difference is the
    // whole reason the platform list includes it.
    expect(isHyperscaler('vmware')).toBe(false);
    expect(isHyperscaler('aws')).toBe(true);
  });
});

describe('multicloud/vmware-on-cloud', () => {
  it('has a service for every hyperscaler', () => {
    expect(VMWARE_CLOUD_SERVICES.map((s) => s.platform).sort()).toEqual([
      'aws',
      'azure',
      'google',
      'oci',
    ]);
  });

  it('carries provenance on every claim', () => {
    for (const service of VMWARE_CLOUD_SERVICES) {
      expect(service.operatingModel.verification).toBeDefined();
      expect(service.licensing.verification).toBeDefined();
      expect(service.vcfVersions.verification).toBeDefined();
    }
  });

  it('marks an unverified claim as inferred and says why', () => {
    // GCVE's version list was not confirmed, and a caveat is how that is said.
    const gcve = vmwareCloudService('google');
    expect(gcve?.vcfVersions.verification).toBe('I');
    expect(gcve?.vcfVersions.caveat).toBeDefined();
  });

  it('knows Amazon EVS runs VCF 9.1', () => {
    const evs = vmwareCloudService('aws');
    expect(supportsVcfVersion(evs!, '9.1')).toBe('supported');
    // The spec builder carries a four-part version; the line is what matters.
    expect(supportsVcfVersion(evs!, '9.1.1.0')).toBe('supported');
    expect(supportsVcfVersion(evs!, '4.5')).toBe('not-listed');
  });

  it('never reports an unchecked service as unsupported', () => {
    // Not knowing is not the same as knowing it will not work, and conflating
    // them would rule out a platform on the strength of nobody having looked.
    const gcve = vmwareCloudService('google');
    expect(supportsVcfVersion(gcve!, '9.1')).toBe('unknown');
  });

  it('has no service for VCF on owned hardware, which is the point', () => {
    expect(vmwareCloudService('vmware')).toBeUndefined();
  });
});

describe('multicloud/decide', () => {
  const rehost: WorkloadProfile = { disposition: 'rehost', vmCount: 800, latencyToOnPrem: 'tolerant' };

  it('explains every platform it ranks', () => {
    const out = decide(rehost);
    expect(out.ranked).toHaveLength(PLATFORMS.length);
    for (const entry of out.ranked) {
      if (entry.score !== 0) expect(entry.reasons.length).toBeGreaterThan(0);
    }
  });

  it('eliminates rather than penalises what policy forbids', () => {
    const out = decide(rehost, { excluded: ['google', 'oci'] });
    const google = out.ranked.find((r) => r.platform === 'google');
    expect(google?.eliminated).toBe(true);
    expect(out.recommended).not.toBe('google');
    // Eliminated platforms sort last, whatever they scored.
    expect(out.ranked.slice(-2).every((r) => r.eliminated)).toBe(true);
  });

  it('rules out every cloud when a physical dongle is in the way', () => {
    const out = decide({ ...rehost, specialHardware: ['physical-dongle'] });
    expect(out.recommended).toBe('vmware');
    for (const entry of out.ranked.filter((r) => r.platform !== 'vmware')) {
      expect(entry.eliminated).toBe(true);
    }
  });

  it('keeps a latency-critical workload next to what it depends on', () => {
    const out = decide({ ...rehost, latencyToOnPrem: 'critical' });
    expect(out.recommended).toBe('vmware');
    expect(out.findings.map((f) => f.code)).toContain('multicloud.latency.measure-first');
  });

  it('follows the money when there is already a commitment', () => {
    const out = decide(rehost, { existingCommitment: ['azure'], skills: ['azure'] });
    expect(out.recommended).toBe('azure');
  });

  it('does not claim a winner when two platforms are a point apart', () => {
    const out = decide(rehost, { existingCommitment: ['aws', 'azure'], skills: ['aws', 'azure'] });
    expect(out.recommended).toBeUndefined();
    expect(out.findings.map((f) => f.code)).toContain('multicloud.too-close-to-call');
  });

  it('no longer sends every Oracle estate to OCI', () => {
    // Oracle Database@AWS, @Azure and @Google Cloud exist, so the old rule is
    // wrong; what remains is a region constraint on the other three.
    const out = decide({ ...rehost, databases: ['oracle'] });
    const rule = out.rules.find((r) => r.id === 'oracle-database');
    expect(rule?.verification).toBe('V-DOC');
    expect(rule?.effects.aws).toBeGreaterThan(0);
    expect(out.findings.map((f) => f.code)).toContain('multicloud.oracle.region-constrained');
  });

  it('applies Microsoft licensing only when there is Software Assurance to apply', () => {
    const windows: WorkloadProfile = { ...rehost, osFamily: 'windows' };
    const without = decide(windows).rules.map((r) => r.id);
    const with_ = decide(windows, { microsoftSoftwareAssurance: true }).rules.map((r) => r.id);
    expect(without).not.toContain('microsoft-licensing');
    expect(with_).toContain('microsoft-licensing');
  });

  it('cites the source for a portable VCF subscription, and admits what it did not check', () => {
    const out = decide(rehost, { portableVcfSubscription: true });
    const rule = out.rules.find((r) => r.id === 'portable-vcf-subscription');
    expect(rule?.verification).toBe('V-DOC');
    expect(rule?.source).toContain('Azure');
    expect(out.findings.map((f) => f.code)).toContain(
      'multicloud.licensing.portability-unconfirmed',
    );
  });

  it('measures refactor breadth from the capability table rather than asserting it', () => {
    const out = decide({ disposition: 'refactor', vmCount: 40 });
    const rule = out.rules.find((r) => r.id === 'refactor-needs-managed-services');
    expect(rule?.source).toContain('capability table');
    // vSphere loses on a refactor, which is the honest answer.
    expect(rule?.effects.vmware).toBeLessThan(0);
  });

  it('warns that a refactor on a six-month deadline becomes a rushed rehost', () => {
    const out = decide({ disposition: 'refactor', timelineMonths: 4 });
    expect(out.findings.map((f) => f.code)).toContain('multicloud.timeline.refactor-unrealistic');
  });

  it('reports region and sovereignty rather than scoring on a list it cannot hold', () => {
    const out = decide(rehost, { dataResidency: 'Germany', sovereigntyRequired: true });
    const codes = out.findings.map((f) => f.code);
    expect(codes).toContain('multicloud.residency.check-regions');
    expect(codes).toContain('multicloud.sovereignty.differs-in-shape');
    // And neither of them moved a score.
    for (const rule of out.rules) {
      expect(['multicloud.residency', 'multicloud.sovereignty']).not.toContain(rule.id);
    }
  });

  it('hands the answer to the Terraform and Ansible kits', () => {
    const out = decide(rehost, { existingCommitment: ['aws'], skills: ['aws'] });
    expect(out.handoff?.platform).toBe('aws');
    expect(out.handoff?.terraformTarget).toBe('aws');
    expect(out.handoff?.ansibleTarget).toBe('aws');
    // A rehost onto a hyperscaler means its VMware service, not native instances.
    expect(out.handoff?.vmwareService).toBe('Amazon EVS');
    expect(out.findings.map((f) => f.code)).toContain('multicloud.handoff');
  });

  it('does not offer a VMware service for a refactor', () => {
    const out = decide({ disposition: 'refactor' }, { existingCommitment: ['google'], skills: ['google'] });
    expect(out.handoff?.vmwareService).toBeUndefined();
  });

  it('says so when the constraints leave nothing standing', () => {
    const out = decide(rehost, { excluded: ['vmware', 'aws', 'azure', 'google', 'oci'] });
    expect(out.recommended).toBeUndefined();
    expect(out.findings.map((f) => f.code)).toContain('multicloud.no-platform');
  });
});

describe('multicloud/from-inventory', () => {
  const vm = (over: Partial<InventoryVm>): InventoryVm => ({
    name: 'vm',
    powerState: 'poweredOn',
    vcpu: 4,
    memoryGib: 16,
    provisionedGib: 100,
    ...over,
  });

  const inventory = (vms: InventoryVm[]): Inventory => ({ ...emptyInventory({ kind: 'rvtools' }), vms });

  it('counts guest OS families from whatever the collector wrote', () => {
    const out = profileFromInventory(
      inventory([
        vm({ name: 'a', guestOs: 'windows2019srvNext_64Guest' }),
        vm({ name: 'b', guestOs: 'Microsoft Windows Server 2022' }),
        vm({ name: 'c', guestOs: 'Red Hat Enterprise Linux 9 (64-bit)' }),
        vm({ name: 'd', guestOs: 'ubuntu64Guest' }),
      ]),
      { disposition: 'rehost' },
    );
    expect(out.evidence.windows).toBe(2);
    expect(out.evidence.linux).toBe(2);
    expect(out.profile.osFamily).toBe('mixed');
  });

  it('counts an unrecorded guest OS as unknown rather than guessing', () => {
    const out = profileFromInventory(inventory([vm({ guestOs: undefined })]), {
      disposition: 'rehost',
    });
    expect(out.evidence.unknownOs).toBe(1);
    expect(out.profile.osFamily).toBeUndefined();
    expect(out.findings.map((f) => f.code)).toContain('multicloud.inventory.unknown-guest-os');
  });

  it('notices machines big enough to narrow the instance shapes', () => {
    const out = profileFromInventory(inventory([vm({ memoryGib: 512 })]), { disposition: 'rehost' });
    expect(out.profile.specialHardware).toEqual(['large-memory']);
  });

  it('points out the machines that are already switched off', () => {
    const out = profileFromInventory(
      inventory([vm({ powerState: 'poweredOff' }), vm({ powerState: 'poweredOn' })]),
      { disposition: 'rehost' },
    );
    expect(out.evidence.poweredOff).toBe(1);
    expect(out.findings.map((f) => f.code)).toContain('multicloud.inventory.powered-off');
  });

  it('narrows to the chosen clusters', () => {
    const out = profileFromInventory(
      inventory([vm({ cluster: 'a' }), vm({ cluster: 'b' }), vm({ cluster: undefined })]),
      { disposition: 'rehost', clusters: ['a'] },
    );
    expect(out.evidence.vmCount).toBe(1);
  });

  it('says plainly which decisive inputs it cannot supply', () => {
    const out = profileFromInventory(inventory([vm({})]), { disposition: 'rehost' });
    expect(out.findings.map((f) => f.code)).toContain('multicloud.inventory.cannot-determine');
  });

  it('feeds straight into a decision', () => {
    const vms = Array.from({ length: 400 }, (_, i) =>
      vm({ name: `vm-${i}`, guestOs: 'Microsoft Windows Server 2019' }),
    );
    const { profile } = profileFromInventory(inventory(vms), { disposition: 'rehost' });
    const out = decide(profile, { microsoftSoftwareAssurance: true });
    expect(out.recommended).toBe('azure');
    expect(out.handoff?.vmwareService).toBe('AVS');
  });
});

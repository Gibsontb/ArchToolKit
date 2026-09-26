import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { AZURE_CONSTRAINED_LADDER, AZURE_EDSV5, LADDERS, OCI_FLEX } from './rightsize.ts';
import {
  AZURE_CONSTRAINED_PAGE, AZURE_CONSTRAINED_SIZES, OCI_FLEX_SHAPES, SAP_HANA_CERTIFIED, allSpecs, constrainedParent, inCatalog,
  instanceSpec, sapHanaTypes, unspecified, type SpecPlatform,
} from './instance-specs.ts';

const PLATFORMS: readonly SpecPlatform[] = ['aws', 'azure', 'google', 'oci'];

describe('instanceSpec agrees with the rightsize ladders', () => {
  for (const cloud of ['aws', 'azure', 'google'] as const) {
    it(`${cloud}: every ladder entry`, () => {
      for (const t of LADDERS[cloud]) {
        const s = instanceSpec(cloud, t.name);
        expect(s).toBeDefined();
        expect([s!.vcpu, s!.ramGib]).toEqual([t.vcpu, t.ramGib]);
        const klass = t.family === 'general' ? 'general' : t.family === 'compute' ? 'compute' : 'memory';
        expect(s!.class).toBe(klass);
      }
    });
  }
  it('azure: Edsv5 parents and the constrained ladder', () => {
    for (const t of AZURE_EDSV5) expect([instanceSpec('azure', t.name)?.vcpu, instanceSpec('azure', t.name)?.ramGib]).toEqual([t.vcpu, t.ramGib]);
    for (const c of AZURE_CONSTRAINED_LADDER) {
      const s = instanceSpec('azure', c.name);
      expect(s).toBeDefined();
      expect([s!.vcpu, s!.ramGib, s!.constrained?.parent]).toEqual([c.vcpu, c.ramGib, c.parent]);
    }
  });
  it('oci: E5 Flex limits are rightsize.ts\'s', () => {
    const f = OCI_FLEX_SHAPES[OCI_FLEX.name]!;
    expect([f.maxOcpus, f.maxMemoryGb, f.maxGbPerOcpu]).toEqual([OCI_FLEX.maxOcpus, OCI_FLEX.maxMemoryGb, OCI_FLEX.maxGbPerOcpu]);
    expect(instanceSpec('oci', OCI_FLEX.name)?.flex?.vcpuPerOcpu).toBe(2);
  });
});

describe('every described name is sold', () => {
  for (const p of PLATFORMS) {
    it(`${p}: every spec is in the catalogue`, () => {
      const specs = allSpecs(p);
      expect(specs.length).toBeGreaterThan(0);
      for (const s of specs) expect(inCatalog(p, s.name)).toBe(true);
    });
  }
  it('coverage of the catalogue (non-accelerated types mostly described)', () => {
    // OCI's remainder is GPU, HPC, DenseIO1 and older bare metal.
    const min: Record<SpecPlatform, number> = { aws: 0.8, azure: 0.85, google: 0.9, oci: 0.65 };
    for (const p of PLATFORMS) {
      const total = allSpecs(p).filter((s) => !s.constrained).length + unspecified(p).length;
      expect(allSpecs(p).filter((s) => !s.constrained).length / total).toBeGreaterThanOrEqual(min[p]);
    }
  });
  it('an unknown name has no spec', () => {
    expect(instanceSpec('aws', 'm7i.3xlarge')).toBeUndefined();
    expect(instanceSpec('azure', 'Standard_D3s_v5')).toBeUndefined();
  });
});

describe('naming conventions', () => {
  it('derives specs from the family table', () => {
    const s = (p: SpecPlatform, n: string) => { const x = instanceSpec(p, n)!; return [x.vcpu, x.ramGib, x.class, x.arch]; };
    expect(s('aws', 'm7i.2xlarge')).toEqual([8, 32, 'general', 'x86']);
    expect(s('aws', 'r8g.large')).toEqual([2, 16, 'memory', 'arm']);
    expect(s('aws', 'm7i.metal-48xl')).toEqual([192, 768, 'general', 'x86']);
    expect(s('aws', 't3.micro')).toEqual([2, 1, 'burstable', 'x86']);
    expect(s('aws', 'x2iedn.xlarge')).toEqual([4, 128, 'memory', 'x86']);
    expect(s('aws', 'u7in-16tb.224xlarge')).toEqual([896, 16384, 'memory', 'x86']);
    expect(s('azure', 'Standard_D8s_v5')).toEqual([8, 32, 'general', 'x86']);
    expect(s('azure', 'Standard_D8ps_v5')).toEqual([8, 32, 'general', 'arm']);
    expect(s('azure', 'Standard_E96ds_v5')).toEqual([96, 672, 'memory', 'x86']);
    expect(s('azure', 'Standard_M416ms_v2')).toEqual([416, 11400, 'memory', 'x86']);
    expect(s('google', 'n2-highmem-16')).toEqual([16, 128, 'memory', 'x86']);
    expect(s('google', 'c4a-standard-8')).toEqual([8, 32, 'compute', 'arm']);
    expect(s('oci', 'BM.Standard.E5.192')).toEqual([384, 2304, 'general', 'x86']);
    expect(instanceSpec('google', 'n4-standard-8')?.hyperdiskOnly).toBe(true);
    expect(instanceSpec('aws', 'm7i.2xlarge')?.generation).toBe(7);
    expect(instanceSpec('azure', 'Standard_D8s_v5')?.generation).toBe(5);
  });
});

describe('Azure constrained-vCPU sizes (punch list)', () => {
  it('Standard_E16-8ds_v5 is accepted and described', () => {
    expect(inCatalog('azure', 'Standard_E16-8ds_v5')).toBe(true);
    const s = instanceSpec('azure', 'Standard_E16-8ds_v5')!;
    expect([s.vcpu, s.ramGib, s.constrained?.parent, s.constrained?.parentVcpu]).toEqual([8, 128, 'Standard_E16ds_v5', 16]);
    expect(s.source).toContain('constrained-vcpu');
  });
  it('every sellable constrained size has a catalogued parent and fewer active vCPUs', () => {
    expect(AZURE_CONSTRAINED_SIZES.length).toBeGreaterThan(60);
    for (const n of AZURE_CONSTRAINED_SIZES) {
      const p = constrainedParent(n)!;
      expect(inCatalog('azure', p.parent)).toBe(true);
      expect(p.active).toBeLessThan(p.parentVcpu);
    }
  });
  it('page names without a catalogued parent are not accepted', () => {
    expect(AZURE_CONSTRAINED_PAGE).toContain('Standard_E4-2s_v4');
    expect(inCatalog('azure', 'Standard_E4-2s_v4')).toBe(false);
  });
});

describe('SAP HANA certified lists', () => {
  it('every certified type is in the catalogue, and agrees with its spec', () => {
    for (const t of SAP_HANA_CERTIFIED) {
      expect(inCatalog(t.platform, t.type)).toBe(true);
      const s = instanceSpec(t.platform, t.type);
      if (s) {
        expect(s.vcpu).toBe(t.vcpu);
        expect(s.ramGib).toBe(t.memoryGib);
      }
      expect(t.source.startsWith('https://')).toBe(true);
    }
  });
  it('each cloud has a list, smallest memory first', () => {
    for (const p of PLATFORMS) {
      const list = sapHanaTypes(p);
      expect(list.length).toBeGreaterThan(0);
      for (let i = 1; i < list.length; i += 1) expect(list[i]!.memoryGib).toBeGreaterThanOrEqual(list[i - 1]!.memoryGib);
    }
    expect(sapHanaTypes('oci').every((t) => t.verification === 'I')).toBe(true);
  });
});

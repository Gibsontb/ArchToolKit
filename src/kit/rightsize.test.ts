import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  AZURE_CONSTRAINED_LADDER, AZURE_EDSV5, LADDERS, OCI_FLEX, rightsize, rightsizeFor, type RehostCloud,
} from './rightsize.ts';
import { AWS_INSTANCE_TYPE_GROUPS, AZURE_VM_SIZE_GROUPS, GCP_MACHINE_TYPE_GROUPS, OCI_SHAPE_GROUPS, type GroupedValues } from './sizes-data.ts';

const values = (groups: GroupedValues): Set<string> => new Set(Object.values(groups).flatMap((v) => v.split(',')));
const AWS = values(AWS_INSTANCE_TYPE_GROUPS);
const AZURE = values(AZURE_VM_SIZE_GROUPS);
const GOOGLE = values(GCP_MACHINE_TYPE_GROUPS);
const OCI = values(OCI_SHAPE_GROUPS);

describe('kit/rightsize: rightsize() is unchanged', () => {
  it('picks the smallest type by memory per vCPU, as before', () => {
    expect(rightsize('aws', 4, 16)).toEqual({ type: 'm7i.xlarge', vcpu: 4, ramGib: 16 });
    expect(rightsize('aws', 4, 8)).toEqual({ type: 'c7i.xlarge', vcpu: 4, ramGib: 8 });
    expect(rightsize('azure', 16, 128)).toEqual({ type: 'Standard_E16s_v5', vcpu: 16, ramGib: 128 });
    expect(rightsize('google', 2, 8)).toEqual({ type: 'n2-standard-2', vcpu: 2, ramGib: 8 });
    expect(rightsize('oci', 16, 128)).toEqual({ type: 'VM.Standard.E5.Flex', vcpu: 16, ramGib: 128, ocpus: 8 });
    expect(rightsize('aws', 400, 16)).toBeNull();
  });
});

describe('kit/rightsize: every ladder size is in the machine catalog', () => {
  it('aws, azure and google ladders, the Edsv5 parents and OCI Flex', () => {
    for (const t of LADDERS.aws) expect(AWS.has(t.name)).toBe(true);
    for (const t of LADDERS.azure) expect(AZURE.has(t.name)).toBe(true);
    for (const t of LADDERS.google) expect(GOOGLE.has(t.name)).toBe(true);
    for (const t of AZURE_EDSV5) expect(AZURE.has(t.name)).toBe(true);
    expect(OCI.has(OCI_FLEX.name)).toBe(true);
  });

  it('the Azure constrained-vCPU ladder: each parent is in AZURE_VM_SIZE_GROUPS, and the names follow E{N}-{n}ds_v5', () => {
    expect(AZURE_CONSTRAINED_LADDER.map((c) => c.name)).toEqual([
      'Standard_E4-2ds_v5', 'Standard_E8-2ds_v5', 'Standard_E8-4ds_v5', 'Standard_E16-4ds_v5', 'Standard_E16-8ds_v5',
      'Standard_E32-8ds_v5', 'Standard_E32-16ds_v5', 'Standard_E64-16ds_v5', 'Standard_E64-32ds_v5',
    ]);
    for (const c of AZURE_CONSTRAINED_LADDER) {
      expect(AZURE.has(c.parent)).toBe(true);
      expect(c.name).toBe(c.parent.replace(/^Standard_E(\d+)ds_v5$/, `Standard_E$1-${c.vcpu}ds_v5`));
      expect(c.vcpu).toBeLessThan(c.parentVcpu);
    }
  });

  // sizes-data.ts is generated from Microsoft's series ladders, which list only
  // the parents; the generator (tools/fetch-compute-catalog.mjs) needs the
  // constrained-vCPU page added before this can pass.
  it('the constrained ids are in AZURE_VM_SIZE_GROUPS', { todo: 'regenerate sizes-data.ts with the constrained-vCPU sizes' }, () => {
    for (const c of AZURE_CONSTRAINED_LADDER) expect(AZURE.has(c.name)).toBe(true);
  });
});

describe('kit/rightsize: rightsizeFor', () => {
  it('without options it is rightsize()', () => {
    for (const cloud of ['aws', 'azure', 'google', 'oci'] as RehostCloud[]) {
      expect(rightsizeFor(cloud, 6, 20)).toEqual(rightsize(cloud, 6, 20));
    }
  });

  it('active memory: ×1.2 headroom with a 2 GiB floor', () => {
    expect(rightsizeFor('aws', 2, 10, { memoryBasis: 'active' })).toEqual(rightsize('aws', 2, 12));
    expect(rightsizeFor('aws', 2, 0.5, { memoryBasis: 'active' })).toEqual(rightsize('aws', 2, 2));
  });

  it('minVcpu raises the vCPU', () => {
    expect(rightsizeFor('aws', 1, 2, { minVcpu: 4 })?.vcpu).toBe(4);
  });

  it('licence-optimised 16 vCPU / 128 GiB Oracle host on all four clouds', () => {
    expect(rightsizeFor('aws', 16, 128, { licenceOptimised: true })).toEqual({ type: 'r7i.4xlarge', vcpu: 16, ramGib: 128, coreCount: 8 });
    expect(rightsizeFor('azure', 16, 128, { licenceOptimised: true })).toEqual({
      type: 'Standard_E16-8ds_v5', vcpu: 8, ramGib: 128, coreCount: 8, constrained: 'Standard_E16ds_v5',
    });
    expect(rightsizeFor('google', 16, 128, { licenceOptimised: true })).toEqual({ type: 'n2-highmem-16', vcpu: 16, ramGib: 128, coreCount: 8 });
    expect(rightsizeFor('oci', 16, 128, { licenceOptimised: true })).toEqual({ type: 'VM.Standard.E5.Flex', vcpu: 16, ramGib: 128, ocpus: 8 });
  });

  it('licence-optimised: memory decides the type, the vCPU decides the active cores', () => {
    expect(rightsizeFor('aws', 4, 128, { licenceOptimised: true })).toEqual({ type: 'r7i.4xlarge', vcpu: 4, ramGib: 128, coreCount: 2 });
    expect(rightsizeFor('azure', 4, 128, { licenceOptimised: true })?.type).toBe('Standard_E16-4ds_v5');
    expect(rightsizeFor('google', 4, 128, { licenceOptimised: true })).toEqual({ type: 'n2-highmem-16', vcpu: 4, ramGib: 128, coreCount: 2 });
    // More cores than the memory's type has: the next type up.
    expect(rightsizeFor('aws', 32, 128, { licenceOptimised: true })).toEqual({ type: 'r7i.8xlarge', vcpu: 32, ramGib: 256, coreCount: 16 });
    // No constrained size fits: the parent itself.
    expect(rightsizeFor('azure', 4, 16, { licenceOptimised: true })).toEqual({ type: 'Standard_E2ds_v5', vcpu: 2, ramGib: 16 });
    expect(rightsizeFor('aws', 16, 4096, { licenceOptimised: true })).toBeNull();
  });

  it('every licence-optimised answer is a catalogued size (or a constrained size of one)', () => {
    for (const [cpu, ram] of [[2, 8], [4, 32], [8, 64], [16, 128], [24, 200], [32, 256], [48, 384], [64, 512]] as const) {
      const aws = rightsizeFor('aws', cpu, ram, { licenceOptimised: true });
      const az = rightsizeFor('azure', cpu, ram, { licenceOptimised: true });
      const gcp = rightsizeFor('google', cpu, ram, { licenceOptimised: true });
      expect(AWS.has(aws!.type)).toBe(true);
      expect(GOOGLE.has(gcp!.type)).toBe(true);
      expect(AZURE.has(az!.constrained ?? az!.type)).toBe(true);
      if (az!.constrained) expect(AZURE_CONSTRAINED_LADDER.some((c) => c.name === az!.type)).toBe(true);
    }
  });
});

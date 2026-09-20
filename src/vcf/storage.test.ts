import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { buildSddcSpec, PLACEHOLDER_SECRET, type DeploymentPlan } from './spec-builder.ts';
import { validateSddcSpec } from './spec-validate.ts';
import { hasErrors } from '../core/findings.ts';

function basePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    sddcId: 'vcf-m01',
    domainSuffix: 'vcf.lab',
    namePrefix: 'vcf-m01',
    esxHostnameBase: 'esx',
    hostCount: 4,
    dnsServers: ['192.168.30.29', '192.168.30.30'],
    ntpServers: ['192.168.30.1', '192.168.30.2'],
    management: { cidr: '172.30.0.0/24', vlanId: 30 },
    vmotion: { cidr: '172.30.40.0/24', vlanId: 40 },
    hostTep: { cidr: '172.30.60.0/24', vlanId: 60 },
    storage: 'vsan-esa',
    ...overrides,
  };
}

const codes = (findings: readonly { code: string }[]): string[] => findings.map((f) => f.code);

describe('NFS principal storage', () => {
  it('produces a deployable volume when the fields are supplied', () => {
    // Selecting NFS with no server detail used to emit a placeholder server
    // name, which the installer cannot act on. The fields are now reachable.
    const { spec, findings } = buildSddcSpec(
      basePlan({
        storage: 'nfs',
        nfs: { cidr: '172.30.70.0/24', vlanId: 70 },
        nfsServers: ['172.30.70.10', '172.30.70.11'],
        nfsPath: '/export/vcf-m01',
        nfsReadOnly: false,
        nfsUserTag: 'management',
        nfsBindToVmknic: true,
        datastoreName: 'vcf-m01-nfs01',
      }),
    );

    const volume = spec.datastoreSpec?.nfsDatastoreSpec;
    expect(volume?.datastoreName).toBe('vcf-m01-nfs01');
    expect(volume?.nasVolume.serverName).toEqual(['172.30.70.10', '172.30.70.11']);
    expect(volume?.nasVolume.path).toBe('/export/vcf-m01');
    expect(volume?.nasVolume.readOnly).toBe(false);
    expect(volume?.nasVolume.userTag).toBe('management');
    expect(volume?.nasVolume.enableBindToVmknic).toBe(true);

    expect(codes(findings)).not.toContain('vcf.build.nfs-no-server');
    expect(JSON.stringify(volume)).not.toContain(PLACEHOLDER_SECRET);
    expect(hasErrors(validateSddcSpec(spec))).toBe(false);
  });

  it('still warns when no server is supplied', () => {
    const { spec, findings } = buildSddcSpec(basePlan({ storage: 'nfs' }));
    expect(codes(findings)).toContain('vcf.build.nfs-no-server');
    expect(JSON.stringify(spec.datastoreSpec?.nfsDatastoreSpec)).toContain(PLACEHOLDER_SECRET);
  });
});

describe('VMFS on FC principal storage', () => {
  it('emits one fcSpec entry per named LUN', () => {
    const { spec } = buildSddcSpec(
      basePlan({ storage: 'vmfs-fc', vmfsDatastoreNames: ['vcf-lun01', 'vcf-lun02'] }),
    );
    expect(spec.datastoreSpec?.vmfsDatastoreSpec?.fcSpec).toEqual([
      { datastoreName: 'vcf-lun01' },
      { datastoreName: 'vcf-lun02' },
    ]);
    expect(hasErrors(validateSddcSpec(spec))).toBe(false);
  });

  it('falls back to a single datastore name', () => {
    const { spec } = buildSddcSpec(basePlan({ storage: 'vmfs-fc', datastoreName: 'vcf-fc01' }));
    expect(spec.datastoreSpec?.vmfsDatastoreSpec?.fcSpec).toEqual([{ datastoreName: 'vcf-fc01' }]);
  });
});

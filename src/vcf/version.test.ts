import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import {
  DEFAULT_VCF_VERSION,
  compareVcfVersion,
  atLeastVcfVersion,
  automationIpCount,
  defaultApplianceSize,
} from './version.ts';
import { buildSddcSpec, type DeploymentPlan } from './spec-builder.ts';
import { validateSddcSpec } from './spec-validate.ts';
import { scenarioRule } from './scenarios.ts';

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
    vsan: { cidr: '172.30.50.0/24', vlanId: 50 },
    hostTep: { cidr: '172.30.60.0/24', vlanId: 60 },
    storage: 'vsan-esa',
    ...overrides,
  };
}

describe('VCF version comparison', () => {
  it('orders four-part versions numerically, not lexically', () => {
    // "9.1.0.400" sorts before "9.1.0.50" as a string; as a version it does not.
    expect(compareVcfVersion('9.1.0.400', '9.1.0.50')).toBeGreaterThan(0);
    expect(compareVcfVersion('9.1.0.0', '9.1.1.0')).toBeLessThan(0);
    expect(compareVcfVersion('9.1.1.0', '9.1.1.0')).toBe(0);
  });

  it('treats a missing trailing part as zero', () => {
    expect(atLeastVcfVersion('9.1.1', '9.1.1.0')).toBe(true);
    expect(atLeastVcfVersion('9.1', '9.1.0.400')).toBe(false);
  });

  it('defaults to the GA release the JSON spec workflow requires', () => {
    expect(DEFAULT_VCF_VERSION).toBe('9.1.1.0');
  });

  it('treats Broadcom\u2019s two spellings of a patch release as the same version', () => {
    // The deployment guide writes "9.1.0.400" while the release notes are titled
    // "9.1.0.0400". Parsing each part as a number makes them equal, which is
    // what stops the Automation pool size flipping on a spelling difference.
    expect(compareVcfVersion('9.1.0.400', '9.1.0.0400')).toBe(0);
    expect(automationIpCount('9.1.0.0400')).toBe(6);
  });
});

describe('target version sanity', () => {
  it('warns when the target predates the schema being emitted', () => {
    const { findings } = buildSddcSpec(basePlan({ version: '9.0.0.0' }));
    expect(findings.map((f) => f.code)).toContain('vcf.build.version-below-9-1');
  });

  it('is quiet for a 9.1 target', () => {
    const { findings } = buildSddcSpec(basePlan({ version: '9.1.0.0' }));
    expect(findings.map((f) => f.code)).not.toContain('vcf.build.version-below-9-1');
  });
});

describe('version-dependent rules', () => {
  it('sizes the VCF Automation pool at 5 before 9.1.0.400 and 6 after', () => {
    // Previously recorded as an unresolved 5-vs-6 discrepancy. It is a version
    // boundary: Broadcom documents 5 for 9.1.0.0-9.1.0.300 and 6 from 9.1.0.400.
    expect(automationIpCount('9.1.0.0')).toBe(5);
    expect(automationIpCount('9.1.0.300')).toBe(5);
    expect(automationIpCount('9.1.0.400')).toBe(6);
    expect(automationIpCount('9.1.1.0')).toBe(6);
  });

  it('emits six Automation addresses by default', () => {
    const { spec } = buildSddcSpec(basePlan());
    expect(spec.vcfAutomationSpec?.ipPool).toHaveLength(6);
  });

  it('emits five Automation addresses when targeting an earlier release', () => {
    const { spec } = buildSddcSpec(basePlan({ version: '9.1.0.0' }));
    expect(spec.vcfAutomationSpec?.ipPool).toHaveLength(5);
  });

  it('defaults HA to medium on 9.1.0.x and small from 9.1.1', () => {
    expect(defaultApplianceSize('9.1.0.0', true)).toBe('medium');
    expect(defaultApplianceSize('9.1.1.0', true)).toBe('small');
    // The simple model was always small.
    expect(defaultApplianceSize('9.1.0.0', false)).toBe('small');
  });

  it('applies the size rule to the Operations appliance', () => {
    const current = buildSddcSpec(basePlan({ profile: 'ha' })).spec;
    const older = buildSddcSpec(basePlan({ profile: 'ha', version: '9.1.0.0' })).spec;
    expect(current.vcfOperationsSpec?.applianceSize).toBe('small');
    expect(older.vcfOperationsSpec?.applianceSize).toBe('medium');
  });
});

describe('deferred components: the worked example supersedes the summary table', () => {
  it('treats vCenter as existing and Operations as new', () => {
    // Broadcom's summary table has these two columns the other way round, which
    // would mean adding deferred components to an instance whose vCenter does
    // not yet exist. The worked example for this very workflow disagrees.
    const rule = scenarioRule('deferred-components');
    expect(rule.vcenterExisting).toBe('true');
    expect(rule.operationsExisting).toBe('false');
  });

  it('records the disagreement rather than hiding it', () => {
    const rule = scenarioRule('deferred-components');
    expect(rule.supersedesTable).toHaveLength(2);

    const { findings } = buildSddcSpec(basePlan({ scenario: 'deferred-components' }));
    expect(findings.map((f) => f.code)).toContain('vcf.build.scenario-table-superseded');
  });
});

describe('internal cluster CIDR: IPv6', () => {
  it('accepts a documented IPv6 prefix', () => {
    const { spec } = buildSddcSpec(basePlan({ internalClusterCidrIpv6: 'fd00::/111' }));
    expect(validateSddcSpec(spec).map((f) => f.code)).not.toContain(
      'vcf.spec.invalid-internal-cidr-v6',
    );
  });

  it('rejects an IPv6 prefix outside the supported list', () => {
    const { spec } = buildSddcSpec(basePlan({ internalClusterCidrIpv6: 'fd12::/64' }));
    expect(validateSddcSpec(spec).map((f) => f.code)).toContain(
      'vcf.spec.invalid-internal-cidr-v6',
    );
  });
});

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { REAL_SPECS, ONE_NODE_VSAN_ESA, THREE_NODE_VSAN_ESA } from './__fixtures__/real-specs.ts';
import { validateSddcSpec } from './spec-validate.ts';
import { SDDC_SPEC_TOP_LEVEL_KEYS } from './spec-types.ts';
import { hasErrors } from '../core/findings.ts';

/**
 * Conformance against specs that actually deployed.
 *
 * These are real VCF 9.1.0.0 documents from lamw/vcf-91-in-box. If the
 * validator rejects one of them, the validator is wrong — not the spec. This
 * is the strongest check available without a live installer.
 */
describe('conformance: real 9.1.0.0 specs', () => {
  for (const { name, spec } of REAL_SPECS) {
    it(`accepts ${name} without errors`, () => {
      const findings = validateSddcSpec(spec);
      const errors = findings.filter((f) => f.severity === 'error');
      if (errors.length > 0) {
        throw new Error(
          `Validator rejected a spec that really deployed:\n${errors
            .map((f) => `  ${f.code} @ ${f.path ?? '-'}: ${f.message}`)
            .join('\n')}`,
        );
      }
      expect(hasErrors(findings)).toBe(false);
    });

    it(`uses only keys the 9.1 schema defines in ${name}`, () => {
      const known = new Set<string>(SDDC_SPEC_TOP_LEVEL_KEYS);
      const unknown = Object.keys(spec).filter((k) => !known.has(k));
      expect(unknown).toEqual([]);
    });
  }
});

describe('conformance: what the real specs reveal', () => {
  it('confirms SddcHostSpec carries no per-host IP or disk selection', () => {
    // The recurring assumption is that hosts need IPs and device paths here.
    // A spec that deployed proves otherwise.
    const host = ONE_NODE_VSAN_ESA.hostSpecs?.[0] as Record<string, unknown>;
    expect(Object.keys(host).sort()).toEqual(['credentials', 'hostname']);
  });

  it('confirms VLAN ids are accepted as strings', () => {
    const mgmt = ONE_NODE_VSAN_ESA.networkSpecs.find((n) => n.networkType === 'MANAGEMENT');
    expect(typeof mgmt?.vlanId).toBe('string');
    // And our validator must not reject that.
    expect(validateSddcSpec(ONE_NODE_VSAN_ESA).map((f) => f.code)).not.toContain(
      'vcf.spec.invalid-vlan',
    );
  });

  it('confirms the two different range shapes coexist in one document', () => {
    const tepRange =
      ONE_NODE_VSAN_ESA.nsxtSpec?.ipAddressPoolSpec?.subnets?.[0]?.ipAddressPoolRanges?.[0];
    const vmotion = ONE_NODE_VSAN_ESA.networkSpecs.find((n) => n.networkType === 'VMOTION');
    expect(Object.keys(tepRange as object).sort()).toEqual(['end', 'start']);
    expect(Object.keys(vmotion?.includeIpAddressRanges?.[0] as object).sort()).toEqual([
      'endIpAddress',
      'startIpAddress',
    ]);
  });

  it('confirms nsxTeamings spells standByUplinks with a capital B', () => {
    const teaming = ONE_NODE_VSAN_ESA.dvsSpecs?.[0]?.nsxTeamings?.[0] as Record<string, unknown>;
    expect('standByUplinks' in teaming).toBe(true);
    expect('standbyUplinks' in teaming).toBe(false);
  });

  it('confirms empty objects request default service deployment', () => {
    expect(ONE_NODE_VSAN_ESA.saltSpec).toEqual({});
    expect(ONE_NODE_VSAN_ESA.fleetDepotSpec).toEqual({});
    expect(ONE_NODE_VSAN_ESA.telemetryAcceptorSpec).toEqual({});
  });

  it('confirms the undocumented vspClusterSpec.name is present', () => {
    expect((ONE_NODE_VSAN_ESA.vspClusterSpec as Record<string, unknown>).name).toBe(
      'vcf-m01-vmsp-01',
    );
  });

  it('confirms fleetLcm and sddcLcm hostnames mirror the vsp FQDNs', () => {
    // Which is why those values must also appear on vspClusterSpec, where the
    // schema actually defines them.
    expect(ONE_NODE_VSAN_ESA.fleetLcmSpec?.hostname).toBe(
      ONE_NODE_VSAN_ESA.vspClusterSpec?.fleetFqdn,
    );
    expect(ONE_NODE_VSAN_ESA.sddcLcmSpec?.hostname).toBe(
      ONE_NODE_VSAN_ESA.vspClusterSpec?.instanceFqdn,
    );
  });

  it('confirms Automation ships six pool addresses, not the documented five', () => {
    expect(ONE_NODE_VSAN_ESA.vcfAutomationSpec?.ipPool).toHaveLength(6);
  });

  it('carries no license key field anywhere', () => {
    expect(/licenseKey|licenseFile/i.test(JSON.stringify(ONE_NODE_VSAN_ESA))).toBe(false);
  });

  it('never carries the field removed in 9.1', () => {
    for (const { spec } of REAL_SPECS) {
      expect('vcfOperationsFleetManagementSpec' in spec).toBe(false);
    }
  });

  it('skips thumbprint validation, since no host supplies a thumbprint', () => {
    expect(ONE_NODE_VSAN_ESA.skipEsxThumbprintValidation).toBe(true);
    const anyThumbprint = THREE_NODE_VSAN_ESA.hostSpecs?.some(
      (h) => h.sshThumbprint || h.sslThumbprint,
    );
    expect(anyThumbprint).toBe(false);
  });
});

describe('conformance: warnings the real specs legitimately trigger', () => {
  it('warns that host names are FQDNs rather than short names', () => {
    // The schema says the subdomain is appended to a short name, yet these
    // working specs pass full FQDNs. A warning is correct; an error would not be.
    const findings = validateSddcSpec(ONE_NODE_VSAN_ESA);
    const fqdnWarning = findings.find((f) => f.code === 'vcf.spec.host-fqdn-not-short-name');
    expect(fqdnWarning).toBeDefined();
    expect(fqdnWarning?.severity).toBe('warning');
  });

  it('warns about a single DNS server without failing the spec', () => {
    const findings = validateSddcSpec(ONE_NODE_VSAN_ESA);
    expect(findings.map((f) => f.code)).toContain('vcf.spec.single-nameserver');
    expect(hasErrors(findings)).toBe(false);
  });
});

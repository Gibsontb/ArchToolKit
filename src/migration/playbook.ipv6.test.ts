/**
 * The migration plan has to say what happens to the addresses — both families.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { playbookFor } from './playbook.ts';

describe('migration/playbook: dual-stack and re-addressing', () => {
  it('inventories IPv4 and IPv6 addresses, and plans the re-addressing', () => {
    const plan = playbookFor('Rehost', 'aws', false).join('\n');
    expect(plan).toContain('IPv4 and IPv6: A and AAAA records');
    expect(plan).toContain('Re-addressing plan');
    expect(plan).toContain('Decide dual-stack or IPv4-only per subnet');
    expect(plan).toContain('change the A and AAAA records together');
    expect(plan).toContain('Test over IPv4 and IPv6 separately');
  });

  it('names each cloud’s own dual-stack construct', () => {
    expect(playbookFor('Rehost', 'aws', false).join('\n')).toContain('egress-only internet gateway');
    expect(playbookFor('Rehost', 'azure', false).join('\n')).toContain('Dual-stack VNet');
    expect(playbookFor('Rehost', 'gcp', false).join('\n')).toContain('IPV4_IPV6');
    expect(playbookFor('Rehost', 'oci', false).join('\n')).toContain('IPv6-enabled VCN');
  });

  it('leaves the plans that move nothing alone', () => {
    expect(playbookFor('Retire', 'aws', false).join('\n')).not.toContain('AAAA');
  });
});

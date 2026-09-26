/**
 * mig_reachable: wait until every host answers, then read its facts.
 *
 * The first play of a migration site: a VM that has just been launched or
 * replicated takes minutes to boot and start SSH or WinRM, and every later
 * play relies on the facts gathered here.
 */

import { migrationBlueprint, number } from './common.ts';

export const MIG_REACHABLE = migrationBlueprint({
  id: 'mig_reachable',
  label: 'Migration – Wait for hosts and read facts',
  description: 'Wait for each host to answer over SSH or WinRM (up to the timeout), then gather its facts.',
  inputs: [{ id: 'timeout', label: 'Wait up to', control: 'number', default: 600, min: 30, max: 7200, hint: 'seconds' }],
  gatherFacts: false,
  vars: () => ({}),
  tasks: (v) => [
    { name: 'Wait for the host to answer', 'ansible.builtin.wait_for_connection': { timeout: number(v.timeout, 600), sleep: 10 } },
    { name: 'Read its facts', 'ansible.builtin.setup': {} },
  ],
});

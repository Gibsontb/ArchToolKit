/**
 * Inputs every playbook blueprint carries.
 */

                                                             

/**
 * Which hosts the play runs against.
 *
 * Cloud modules talk to an API and so run from the control node, which is why
 * `localhost` belongs here for those; anything that configures a host directly
 * wants a group from the inventory.
 */
export const HOSTS_INPUT                 = {
  id: 'hosts',
  label: 'Run against',
  control: 'text',
  default: 'all',
  hint: 'Inventory pattern — a group name, or localhost for API work',
};

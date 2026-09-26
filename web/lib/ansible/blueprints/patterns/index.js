/**
 * The Ansible blueprints for application patterns (addendum A.4.10, WP-17),
 * and mig_source_tools, the post-cutover play the migration site adds
 * (A.3.5), by the host family they manage. The ones that manage both
 * families are in both lists.
 */

                                                           
import { APP_FSLOGIX } from './fslogix.js';
import { APP_IIS_SITE } from './iis-site.js';
import { INFRA_ADCS, INFRA_DHCP } from './infra.js';
import { APP_MM2 } from './mm2.js';
import { APP_SAP_PRECONFIGURE } from './sap-preconfigure.js';
import { MIG_SOURCE_TOOLS } from './source-tools.js';
import { APP_VELERO } from './velero.js';

export { APP_GROUP } from './common.js';
export { APP_FSLOGIX, APP_IIS_SITE, APP_MM2, APP_SAP_PRECONFIGURE, APP_VELERO, INFRA_ADCS, INFRA_DHCP, MIG_SOURCE_TOOLS };

/** Every pattern blueprint once. */
export const PATTERN_ANSIBLE_BLUEPRINTS                       = [
  MIG_SOURCE_TOOLS,
  APP_FSLOGIX,
  APP_SAP_PRECONFIGURE,
  INFRA_DHCP,
  INFRA_ADCS,
  APP_VELERO,
  APP_MM2,
  APP_IIS_SITE,
];

const LINUX = new Set(['mig_source_tools', 'app_sap_preconfigure', 'app_velero', 'app_mm2']);
const WINDOWS = new Set(['mig_source_tools', 'app_fslogix', 'infra_dhcp', 'infra_adcs', 'app_iis_site']);

/** On the Generic Linux hosts platform. */
export const PATTERN_ANSIBLE_LINUX                       = PATTERN_ANSIBLE_BLUEPRINTS.filter((b) => LINUX.has(b.id));
/** On the Generic Windows hosts platform. */
export const PATTERN_ANSIBLE_WINDOWS                       = PATTERN_ANSIBLE_BLUEPRINTS.filter((b) => WINDOWS.has(b.id));

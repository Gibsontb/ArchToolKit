/**
 * Region, zone and boolean option lists for the Ansible blueprints.
 *
 * Re-exported from the canonical lists so the two generators cannot drift apart
 * about which regions exist. See src/kit/regions.ts for why that matters.
 *
 * AZURE_LOCATIONS is the same list as AZURE_REGIONS; the previous toolkit used
 * Azure's own word for it here, and the templates still do.
 */

export { AWS_REGIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from '../../kit/regions.ts';
export { AZURE_REGIONS as AZURE_LOCATIONS, OCI_REGIONS } from '../../kit/regions.ts';

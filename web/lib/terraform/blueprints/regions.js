/**
 * Region and zone lists for the Terraform blueprints.
 *
 * Re-exported from the canonical lists so the two generators cannot drift apart
 * about which regions exist. See src/kit/regions.ts for why that matters.
 */

export {
  AWS_REGIONS,
  AZURE_REGIONS,
  GCP_REGIONS,
  GCP_ZONES,
  OCI_REGIONS,
} from '../../kit/regions.js';

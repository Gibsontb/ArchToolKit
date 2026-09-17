# Provider Catalog Pipeline (All Services)

This adds a **refreshable provider inventory** for AWS/Azure/GCP/OCI and generates the ATK catalog JS files:
`web/cloud-decision-logic-kit/data/*-services.js`

## Folders
- `data/raw/provider-inventory/` raw pulls (do not hand-edit)
- `data/imports/provider-inventory/` normalized JSON used by generators
- `data/overrides/` optional overrides/mappings
- `web/cloud-decision-logic-kit/data/*-services.js` generated catalogs loaded by ATK

## Commands
- Refresh all + validate + build:
  - `npm run catalog:refresh`
- Or per provider:
  - `npm run catalog:refresh:aws`
  - `npm run catalog:refresh:azure`
  - `npm run catalog:refresh:gcp`
  - `npm run catalog:refresh:oci`
- Validate normalized inventories:
  - `npm run catalog:validate`
- Generate JS catalogs:
  - `npm run catalog:build`

## Requirements
- Node 18+ (Node 20+ recommended)
- Azure: Azure CLI (`az`) + `az login`
- GCP: gcloud CLI + `gcloud auth login` + project set
- AWS: internet access to AWS pricing index (no credentials required)
- OCI: maintain `data/raw/provider-inventory/oci.manual.json` (starter provided)

## Notes
- The generator places all services under one category: **ALL SERVICES (Inventory)**.
  This ensures migration matching can see *every* service name.
- Next step (optional): enrich with your master equivalency matrix for better categorization and cross-cloud matching.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLACEMENT_REGIONS,regionEnvironment,placementRegionOptions,requiresRestrictedSite } from './placement-regions.ts';
import { AWS_REGIONS,AZURE_REGIONS,GCP_REGIONS,OCI_REGIONS } from './regions.ts';
import { AWS_REGION_REFERENCE } from './aws-region-reference.ts';
test('region choices include the entire provider lists without an environment filter',()=>{
  assert.deepEqual(PLACEMENT_REGIONS,{aws:AWS_REGIONS,azure:AZURE_REGIONS,google:GCP_REGIONS,oci:OCI_REGIONS});
  assert.ok(PLACEMENT_REGIONS.aws!.length>30);
  assert.ok(PLACEMENT_REGIONS.aws!.includes('us-gov-east-1'));
  assert.ok(PLACEMENT_REGIONS.aws!.includes('us-gov-west-1'));
});
test('normal dropdowns exclude classified-only sites and retain government regions',()=>{
 for(const platform of ['aws','azure','google','oci'])assert.ok(placementRegionOptions(platform).every(row=>!requiresRestrictedSite(platform,row.value)));
 assert.ok(placementRegionOptions('aws').some(row=>row.value==='us-gov-east-1'));
 assert.ok(placementRegionOptions('aws').some(row=>row.value==='us-gov-west-1'));
 assert.ok(placementRegionOptions('azure').some(row=>row.value==='usgovvirginia'));
 assert.ok(requiresRestrictedSite('aws','us-iso-east-1'));
 assert.ok(requiresRestrictedSite('google','site:google-gdc-secret'));
});

test('AWS uses published SDK region names and identifiers rather than synthetic sites',()=>{
  const options=placementRegionOptions('aws');
  assert.ok(!options.some(option=>option.value.startsWith('site:')));
  for(const [id,metadata] of Object.entries(AWS_REGION_REFERENCE.regions)){
    if(requiresRestrictedSite('aws',id))continue;
    assert.ok(options.some(option=>option.value===id&&option.label===metadata.name+' — '+id));
  }
  assert.notEqual(AWS_REGION_REFERENCE.regions['us-gov-east-1'].partition,AWS_REGION_REFERENCE.regions['us-iso-east-1'].partition);
});
test('provider context follows the selected region automatically',()=>{
  assert.equal(regionEnvironment('aws','us-gov-east-1'),'govcloud');
  assert.equal(regionEnvironment('aws','us-east-1'),'commercial');
  assert.equal(regionEnvironment('azure','usgovvirginia'),'azure-government');
});

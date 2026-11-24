import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, OCI_REGIONS } from './regions.ts';
import { AWS_REGION_REFERENCE } from './aws-region-reference.ts';

/** One region list per provider; no separate environment choice in the UI. */
export const PLACEMENT_REGIONS:Readonly<Record<string,readonly string[]>>={aws:AWS_REGIONS,azure:AZURE_REGIONS,google:GCP_REGIONS,oci:OCI_REGIONS};
/** Offering/site choices, deliberately not fabricated provider region IDs. */
export const RESTRICTED_SITES:Readonly<Record<string,readonly {value:string;label:string;reference:string}[]>>={
  aws:[],
  azure:[
    {value:'site:azure-secret',label:'Azure Government Secret (authorized site)',reference:'https://learn.microsoft.com/en-us/azure/azure-government/documentation-government-overview-dod'},
    {value:'site:azure-top-secret',label:'Azure Government Top Secret (authorized site)',reference:'https://azure.microsoft.com/en-us/explore/global-infrastructure/government'},
  ],
  google:[
    {value:'site:google-gdc-secret',label:'Google Distributed Cloud air-gapped — Secret site',reference:'https://cloud.google.com/blog/topics/public-sector/google-public-sector-achieves-top-secret-and-secret-cloud-authorization'},
    {value:'site:google-gdc-top-secret',label:'Google Distributed Cloud air-gapped — Top Secret site',reference:'https://cloud.google.com/blog/topics/public-sector/google-public-sector-achieves-top-secret-and-secret-cloud-authorization'},
  ],
  oci:[
    {value:'site:oci-secret-east',label:'Oracle National Security — Secret East site',reference:'https://www.oracle.com/a/ocom/docs/industries/public-sector/oci-scca-architecture-guide.pdf'},
    {value:'site:oci-secret-west',label:'Oracle National Security — Secret West site',reference:'https://www.oracle.com/a/ocom/docs/industries/public-sector/oci-scca-architecture-guide.pdf'},
    {value:'site:oci-secret-south-central',label:'Oracle National Security — Secret South Central site',reference:'https://www.oracle.com/a/ocom/docs/industries/public-sector/oci-scca-architecture-guide.pdf'},
    {value:'site:oci-top-secret-east',label:'Oracle National Security — Top Secret East site',reference:'https://www.oracle.com/a/ocom/docs/industries/public-sector/oci-scca-architecture-guide.pdf'},
    {value:'site:oci-top-secret-south-central',label:'Oracle National Security — Top Secret South Central site',reference:'https://www.oracle.com/a/ocom/docs/industries/public-sector/oci-scca-architecture-guide.pdf'},
  ],
};
export function placementRegionOptions(platform:string):{value:string;label:string}[]{
  return (PLACEMENT_REGIONS[platform]??[]).filter(value=>!requiresRestrictedSite(platform,value)).map(value=>({value,label:regionLabel(value)}));
}
export function requiresRestrictedSite(platform:string,region:string):boolean{
  return region.startsWith('site:')||(platform==='azure'&&/^(ussec|usnat)/.test(region))||(platform==='aws'&&/^(us-iso|eu-isoe-)/.test(region));
}
export function regionLabel(region:string):string{
  const aws=AWS_REGION_REFERENCE.regions[region as keyof typeof AWS_REGION_REFERENCE.regions];
  if(aws)return aws.name+' — '+region;
  const labels:Readonly<Record<string,string>>={
    usgovvirginia:'Azure Government — US Gov Virginia',usgovtexas:'Azure Government — US Gov Texas',usgovarizona:'Azure Government — US Gov Arizona',usgoviowa:'Azure Government — US Gov Iowa',
    usdodcentral:'Azure DoD — US DoD Central',usdodeast:'Azure DoD — US DoD East',
    usseceast:'Azure US Sec East (air-gapped)',ussecwest:'Azure US Sec West (air-gapped)',ussecwestcentral:'Azure US Sec West Central (air-gapped)',
    usnateast:'Azure US Nat East (air-gapped)',usnatwest:'Azure US Nat West (air-gapped)',
    'us-langley-1':'Oracle US Government East (Ashburn)','us-luke-1':'Oracle US Government West (Phoenix)',
    'us-gov-ashburn-1':'Oracle US DoD East (Ashburn)','us-gov-chicago-1':'Oracle US DoD North (Chicago)','us-gov-phoenix-1':'Oracle US DoD West (Phoenix)',
  };
  if(labels[region])return labels[region]+' — '+region;
  return region;
}
/** Provider context is inferred from location for generated files, never another form step. */
export function regionEnvironment(platform:string,region:string):string{
  if(region.startsWith('site:'))return region.includes('top-secret')?'top-secret':'secret';
  if(platform==='aws'){
    if(region.startsWith('us-gov-'))return 'govcloud';
    if(region.startsWith('cn-'))return 'china';
    if(region.startsWith('eusc-'))return 'european-sovereign';
    if(/^(us-iso|eu-isoe-)/.test(region))return 'restricted';
    return 'commercial';
  }
  if(platform==='azure'){
    if(/^(ussec|usnat)/.test(region))return 'azure-air-gapped';
    if(/^(usgov|usdod)/.test(region))return 'azure-government';
    if(region.startsWith('china'))return 'china';
    return 'commercial';
  }
  if(platform==='oci'&&/^(us-langley-|us-luke-|us-gov-|uk-gov-)/.test(region))return 'oci-government';
  return 'standard';
}

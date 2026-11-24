/** Public AWS SDK partition metadata, checked 2026-11-19. Keep vendor names verbatim. */
export const AWS_REGION_REFERENCE={
  source:'https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/partitions.json',
  checked:'2026-11-19',
  regions:{
    'us-gov-east-1':{name:'AWS GovCloud (US-East)',partition:'aws-us-gov'},
    'us-gov-west-1':{name:'AWS GovCloud (US-West)',partition:'aws-us-gov'},
    'us-iso-east-1':{name:'US ISO East',partition:'aws-iso'},
    'us-iso-west-1':{name:'US ISO WEST',partition:'aws-iso'},
    'us-isob-east-1':{name:'US ISOB East (Ohio)',partition:'aws-iso-b'},
    'us-isob-west-1':{name:'US ISOB West',partition:'aws-iso-b'},
    'eu-isoe-west-1':{name:'EU ISOE West',partition:'aws-iso-e'},
    'us-isof-east-1':{name:'US ISOF EAST',partition:'aws-iso-f'},
    'us-isof-south-1':{name:'US ISOF SOUTH',partition:'aws-iso-f'},
    'eusc-de-east-1':{name:'AWS European Sovereign Cloud (Germany)',partition:'aws-eusc'},
  },
} as const;

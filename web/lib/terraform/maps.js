/**
 * Every Terraform Map, in the order the platform picker offers them.
 *
 * Three came out of the previous toolkit and are generated into map-data.ts;
 * the AWS one is written here in the repository because the original was a
 * mislabelled copy of the Azure page. They are the same shape either way, and
 * the page does not know which is which.
 */

                                         
import { AWS_MAP } from './map-aws.js';
import { AZURE_MAP, GOOGLE_MAP, OCI_MAP } from './map-data.js';
                                                  

export const MAPS                      = [AWS_MAP, AZURE_MAP, GOOGLE_MAP, OCI_MAP];

export function mapFor(target        )                       {
  return MAPS.find((map) => map.target === target);
}

export function mappedTargets()                         {
  return MAPS.map((map) => map.target);
}

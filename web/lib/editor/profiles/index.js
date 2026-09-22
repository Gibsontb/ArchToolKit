/**
 * Every profile the data editor offers, and choosing one for a document.
 */

                                      
import { perDocument,                           } from '../profile.js';
import { ansibleInventory, ansiblePlaybook } from './ansible.js';
import { awsCloudFormation, awsIamPolicy } from './aws.js';
import { azureArm, azureParameters, azurePolicy } from './azure.js';
import { f5As3, f5Do } from './f5.js';
import { generic } from './generic.js';
import { googleDeploymentManager, googleIamPolicy } from './google.js';
import { kubernetes } from './kubernetes.js';
import { ociIamPolicy } from './oci.js';
import { terraformJson, terraformVars } from './terraform.js';
import { vcfSpec } from './vcf.js';

/** In the order the profile dropdown lists them, grouped by family. */
export const PROFILES                     = [
  vcfSpec,
  ansiblePlaybook,
  ansibleInventory,
  terraformJson,
  terraformVars,
  awsCloudFormation,
  awsIamPolicy,
  googleIamPolicy,
  googleDeploymentManager,
  azureArm,
  azureParameters,
  azurePolicy,
  ociIamPolicy,
  f5As3,
  f5Do,
  kubernetes,
  generic,
];

export function profileById(id        )                      {
  return PROFILES.find((p) => p.id === id);
}

/** The families in dropdown order, each with its profiles. */
export function profilesByFamily()                        {
  const out = new Map                   ();
  for (const p of PROFILES) out.set(p.family, [...(out.get(p.family) ?? []), p]);
  return [...out];
}

                            
                            
                         
 

/**
 * The profile that best fits the document, highest score first. `multi` says
 * the document is the list of a multi-document YAML file's documents.
 */
export function detectProfile(doc      , name        , multi = false)            {
  let best            = { profile: generic, score: 0 };
  for (const p of PROFILES) {
    const score = perDocument(p, multi).detect(doc, name);
    if (score > best.score) best = { profile: p, score };
  }
  return best;
}

export { perDocument };

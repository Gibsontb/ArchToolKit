/**
 * Every profile the data editor offers, and choosing one for a document.
 */

import type { Json } from '../doc.ts';
import { perDocument, type Family, type Profile } from '../profile.ts';
import { ansibleInventory, ansiblePlaybook } from './ansible.ts';
import { awsCloudFormation, awsIamPolicy } from './aws.ts';
import { azureArm, azureParameters, azurePolicy } from './azure.ts';
import { f5As3, f5Do } from './f5.ts';
import { generic } from './generic.ts';
import { googleDeploymentManager, googleIamPolicy } from './google.ts';
import { kubernetes } from './kubernetes.ts';
import { ociIamPolicy } from './oci.ts';
import { terraformJson, terraformVars } from './terraform.ts';
import { vcfSpec } from './vcf.ts';

/** In the order the profile dropdown lists them, grouped by family. */
export const PROFILES: readonly Profile[] = [
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

export function profileById(id: string): Profile | undefined {
  return PROFILES.find((p) => p.id === id);
}

/** The families in dropdown order, each with its profiles. */
export function profilesByFamily(): [Family, Profile[]][] {
  const out = new Map<Family, Profile[]>();
  for (const p of PROFILES) out.set(p.family, [...(out.get(p.family) ?? []), p]);
  return [...out];
}

export interface Detection {
  readonly profile: Profile;
  readonly score: number;
}

/**
 * The profile that best fits the document, highest score first. `multi` says
 * the document is the list of a multi-document YAML file's documents.
 */
export function detectProfile(doc: Json, name: string, multi = false): Detection {
  let best: Detection = { profile: generic, score: 0 };
  for (const p of PROFILES) {
    const score = perDocument(p, multi).detect(doc, name);
    if (score > best.score) best = { profile: p, score };
  }
  return best;
}

export { perDocument };

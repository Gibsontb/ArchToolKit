/**
 * The platforms a workload can land on, and what each one hands to the rest of
 * the toolkit.
 *
 * The point of naming platforms in one place is that a decision has to become
 * something: choosing AWS means a Terraform provider, an Ansible collection and
 * a set of service names, and if those three vocabularies disagree the decision
 * is useless. So this is the single mapping, and the Terraform and Ansible kits
 * are reached through it rather than named again.
 *
 * `vmware` is a platform here, not merely a source. Staying on vSphere — on
 * owned hardware, or on one of the hyperscalers' VMware services — is a real
 * outcome and often the right one, and a matrix that can only route away from
 * VMware is a matrix with its answer written in advance.
 */

import type { CloudTarget } from '../terraform/providers.ts';
import type { AnsibleTarget } from '../ansible/collections.ts';

export type Platform = 'vmware' | 'aws' | 'azure' | 'google' | 'oci';

export const PLATFORMS: readonly Platform[] = ['vmware', 'aws', 'azure', 'google', 'oci'];

export interface PlatformInfo {
  readonly platform: Platform;
  readonly label: string;
  /** Short name as the vendor writes it, for output the reader will recognise. */
  readonly shortLabel: string;
  /** Terraform provider that builds on this platform. */
  readonly terraform: CloudTarget;
  /** Ansible collection family that configures it. */
  readonly ansible: AnsibleTarget;
  /** What the platform is for, in one line. */
  readonly summary: string;
}

export const PLATFORM_INFO: Readonly<Record<Platform, PlatformInfo>> = {
  vmware: {
    platform: 'vmware',
    label: 'VMware Cloud Foundation (owned hardware)',
    shortLabel: 'VCF',
    terraform: 'vsphere',
    ansible: 'vmware',
    summary:
      'The estate stays on vSphere, on hardware you own. The toolkit can size it and generate the installer specification.',
  },
  aws: {
    platform: 'aws',
    label: 'Amazon Web Services',
    shortLabel: 'AWS',
    terraform: 'aws',
    ansible: 'aws',
    summary: 'The broadest service catalog, and the VMware path is Amazon EVS inside your own VPC.',
  },
  azure: {
    platform: 'azure',
    label: 'Microsoft Azure',
    shortLabel: 'Azure',
    terraform: 'azure',
    ansible: 'azure',
    summary:
      'Strongest where the estate is already Microsoft-licensed, and the VMware path is Azure VMware Solution.',
  },
  google: {
    platform: 'google',
    label: 'Google Cloud Platform (GCP)',
    shortLabel: 'Google Cloud',
    terraform: 'google',
    ansible: 'google',
    summary: 'Data and analytics depth, and the VMware path is Google Cloud VMware Engine.',
  },
  oci: {
    platform: 'oci',
    label: 'Oracle Cloud Infrastructure',
    shortLabel: 'OCI',
    terraform: 'oci',
    ansible: 'oci',
    summary:
      'Oracle licensing is cheapest on Oracle, and the VMware path is Oracle Cloud VMware Solution.',
  },
};

export function platformInfo(platform: Platform): PlatformInfo {
  return PLATFORM_INFO[platform];
}

/** The hyperscalers. VCF on owned hardware is not one, and the difference matters. */
export const HYPERSCALERS: readonly Platform[] = ['aws', 'azure', 'google', 'oci'];

export function isHyperscaler(platform: Platform): boolean {
  return HYPERSCALERS.includes(platform);
}

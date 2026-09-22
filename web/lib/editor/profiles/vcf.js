/**
 * A VCF 9.1 deployment specification: the JSON the VCF Installer takes, and
 * exports once it has deployed. The answer sets and labels are the ones the
 * spec editor already used; the checks are the spec builder's validator.
 */

import { validateSddcSpec } from '../../vcf/spec-validate.js';
import { CHOICES, VCF_LABELS } from '../../vcf/spec-edit.js';
import { pathPattern,           } from '../doc.js';
import { isObj,              } from '../profile.js';

const MARKERS = ['sddcId', 'hostSpecs', 'workflowType', 'vcenterSpec', 'networkSpecs', 'nsxtSpec', 'dvsSpecs', 'vcfInstanceName'];

export const vcfSpec          = {
  id: 'vcf-spec',
  family: 'vcf',
  label: 'VCF 9.1 deployment spec',
  format: 'json',
  source: 'VCF 9.1 Installer API (SddcSpec)',
  detect(doc) {
    if (!isObj(doc)) return 0;
    const hits = MARKERS.filter((k) => k in doc).length;
    return hits >= 3 ? 0.95 : hits * 0.2;
  },
  choices: (path) => CHOICES[pathPattern(path)],
  validate: (doc) => (isObj(doc) ? validateSddcSpec(doc                           ) : []),
  labels: VCF_LABELS,
  itemTitle(value      ) {
    if (!isObj(value)) return undefined;
    const v = value.hostname ?? value.networkType ?? value.dvsName ?? value.name ?? value.datastoreName ?? value.id ?? value.type ?? value.cidr ?? value.startIpAddress;
    return typeof v === 'string' && v ? v : undefined;
  },
};

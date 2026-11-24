                                                     
import { error } from '../core/findings.js';
                                                                         
/** Keep lazy schemas live and enforce catalog lifecycle on every engine's build path. */
export function withAwsServiceEligibility(blueprint           , availability                      )            {
  if (!availability || blueprint.id === 'aws_service_apprunner' || blueprint.inputs.some(input => input.id === 'service_existing_customer')) return blueprint;
  return {
    ...blueprint,
    get inputs() {
      // The generator uses an empty form as its lazy-loading signal.
      if (blueprint.load && blueprint.inputs.length === 0) return blueprint.inputs;
      return availability.status === 'existing-customers-only' ? [
        { id: 'service_existing_customer', label: 'This account already has access to this service', control: 'toggle'         , default: false, hint: availability.message + ' This selection records eligibility; it does not enable AWS service access.' },
        ...blueprint.inputs,
      ] : blueprint.inputs;
    },
    ...(blueprint.load ? { load: () => blueprint.load () } : {}),
    build(values, name) {
      if (availability.status === 'retired') return { files: {}, findings: [error('aws.service.retired', availability.message)] };
      if (values.service_existing_customer !== true && values.service_existing_customer !== 'true') return { files: {}, findings: [error('aws.service.eligibility', 'Verify that this AWS account already has access to the selected service.', { path: 'service_existing_customer' })] };
      return blueprint.build(values, name);
    },
  };
}

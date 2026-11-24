import { error, type Finding } from '../core/findings.ts';
import type { Blueprint } from '../kit/blueprint.ts';
import { quote } from '../terraform/hcl.ts';
import { blk, dat, output, res, x } from '../terraform/blueprints/migration/common.ts';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.ts';

export const AWS_EBS_SERVICE = {
  id: 'aws_service_ebs', label: 'Create an encrypted gp3 EBS volume',
  description: 'Create a gp3 data volume in an existing subnet’s Availability Zone, optionally attaching it to an existing EC2 instance.',
  emits: ['aws_ebs_volume', 'aws_volume_attachment'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Volume name', control: 'text' },
    { id: 'subnet', label: 'Existing subnet ID for Availability Zone', control: 'text' },
    { id: 'size', label: 'Volume capacity (GiB)', control: 'number', min: 1, max: 16384, default: 100 },
    { id: 'iops', label: 'Provisioned IOPS', control: 'number', min: 3000, max: 16000, default: 3000 },
    { id: 'throughput', label: 'Throughput (MiB/s)', control: 'number', min: 125, max: 1000, default: 125 },
    { id: 'kms', label: 'Existing KMS key ARN', control: 'text', hint: 'Optional. Leave blank for the account’s default EBS encryption key.' },
    { id: 'instance', label: 'Existing EC2 instance ID to attach', control: 'text', hint: 'Optional. Must be in the volume’s Availability Zone.' },
    { id: 'device', label: 'Requested device name', control: 'text', default: '/dev/sdf', hint: 'Nitro Linux guests expose EBS volumes as NVMe devices. Identify the actual device by volume ID.' },
  ],
  build(values) {
    const findings: Finding[] = [];
    const reject = (path: string, message: string) => findings.push(error('aws.ebs.' + path, message, { path }));
    const location = String(values.aws_region ?? '');
    const name = String(values.name ?? '').trim();
    const subnet = String(values.subnet ?? '').trim();
    const instance = String(values.instance ?? '').trim();
    const device = String(values.device ?? '').trim();
    const kms = String(values.kms ?? '').trim();
    const size = Number(values.size), iops = Number(values.iops), throughput = Number(values.throughput);
    if (!name || name.length > 256) reject('name', 'Enter a volume name up to 256 characters.');
    if (!/^subnet-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(subnet)) reject('subnet', 'Enter an existing subnet ID.');
    if (!Number.isInteger(size) || size < 1 || size > 16384) reject('size', 'Enter 1–16384 GiB for this gp3 configuration.');
    if (!Number.isInteger(iops) || iops < 3000 || iops > 16000 || (iops > 3000 && iops > size * 500)) reject('iops', 'Use 3000–16000 IOPS, with at most 500 IOPS/GiB above the baseline.');
    if (!Number.isInteger(throughput) || throughput < 125 || throughput > 1000 || throughput > iops / 4) reject('throughput', 'Use 125–1000 MiB/s with at least 4 IOPS per MiB/s.');
    if (instance && !/^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(instance)) reject('instance', 'Enter an existing EC2 instance ID.');
    if (instance && !/^\/dev\/(?:sd|xvd)[f-p]$/.test(device)) reject('device', 'Use an available data device name from /dev/sdf through /dev/sdp, or the xvd equivalents.');
    if (kms) {
      const parsed = /^arn:([^:]+):kms:([^:]+):\d{12}:key\/[A-Za-z0-9-]+$/.exec(kms);
      if (parsed?.[1] !== awsServicePartition(location) || parsed?.[2] !== location) reject('kms', 'Use a key ARN in the selected region and partition.');
    }
    return awsServiceModule(location, [
      dat('aws_subnet', 'location', { id: subnet }),
      ...(instance ? [dat('aws_instance', 'client', { instance_id: instance })] : []),
      res('aws_ebs_volume', 'configured', {
        availability_zone: x('data.aws_subnet.location.availability_zone'), type: 'gp3', size, iops, throughput,
        encrypted: true, ...(kms ? { kms_key_id: kms } : {}), tags: x('{ Name = ' + quote(name) + ' }'),
      }, [
        blk('lifecycle', { prevent_destroy: true }, instance ? [blk('precondition', {
          condition: x('data.aws_instance.client.availability_zone == data.aws_subnet.location.availability_zone'),
          error_message: 'The instance and EBS volume must be in the same Availability Zone.',
        })] : []),
      ]),
      ...(instance ? [res('aws_volume_attachment', 'configured', {
        device_name: device, volume_id: x('aws_ebs_volume.configured.id'), instance_id: instance,
        force_detach: false, stop_instance_before_detaching: false,
      })] : []),
      output('volume_id', 'aws_ebs_volume.configured.id'),
    ], `# gp3 EBS data volume

## Prepare
Confirm available regional gp3 capacity and performance quotas. Select the target subnet's Availability Zone and an available EC2 data-device name. Verify KMS permissions and instance EBS throughput limits. This form creates a new empty volume and can attach it to an existing instance. Confirm guest OS support before selecting a device.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the AWS account, region, Availability Zone, encryption, capacity and performance charges. Apply the saved plan. The volume is protected by prevent_destroy while its configuration remains present.

## Verify
Check describe-volumes and volume-status checks. On the client, identify the device by its EBS volume ID; NVMe names can differ from the requested name. Check for existing filesystem signatures before formatting. Create a filesystem only on the intended empty device, mount it, and verify permissions, I/O and application behavior. Configure the appropriate backup/snapshot policy separately and test restore.

## Recovery
Stop application I/O and unmount the filesystem before any planned detach. Review the attachment change plan. Restore data from a verified snapshot into a separate volume when needed, then verify before switching the application. Do not force-detach a mounted volume. A restored Terraform state does not restore disk data.

https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html
https://docs.aws.amazon.com/ebs/latest/userguide/ebs-using-volumes.html
`, findings);
  },
} satisfies Blueprint;

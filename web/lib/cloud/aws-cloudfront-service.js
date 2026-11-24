import { error,              } from '../core/findings.js';
                                                     
import { blk, dat, e, jsonencode, output, res, x } from '../terraform/blueprints/migration/common.js';
import { validS3BucketName } from './aws-s3-service.js';
import { awsServiceModule, awsServicePartition, awsServiceRegion } from './aws-service-module.js';

export const AWS_CLOUDFRONT_SERVICE = {
  id: 'aws_service_cloudfront', label: 'Set up CloudFront with a private S3 origin',
  description: 'Create a private encrypted S3 content bucket and HTTPS distribution with origin access control and optional custom hostnames.',
  emits: ['aws_cloudfront_distribution', 'aws_cloudfront_origin_access_control', 'aws_s3_bucket', 'aws_s3_bucket_public_access_block', 'aws_s3_bucket_versioning', 'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_policy'],
  inputs: [
    awsServiceRegion,
    { id: 'name', label: 'Distribution description', control: 'text' },
    { id: 'bucket', label: 'New content bucket name', control: 'text' },
    { id: 'root', label: 'Default root object', control: 'text', default: 'index.html' },
    { id: 'price', label: 'Edge location price class', control: 'select', default: 'PriceClass_100', options: [{ value: 'PriceClass_100', label: 'Price class 100' }, { value: 'PriceClass_200', label: 'Price class 200' }, { value: 'PriceClass_All', label: 'All edge locations' }] },
    { id: 'aliases', label: 'Custom hostnames', control: 'text', hint: 'Optional comma-separated DNS hostnames covered by the certificate. Blank uses the generated cloudfront.net hostname.' },
    { id: 'certificate', label: 'Existing ACM certificate ARN in us-east-1', control: 'text', hint: 'Required when using custom hostnames. Certificate must be issued in this deployment account and cover every hostname.' },
    { id: 'waf', label: 'Existing CloudFront WAFv2 web ACL ARN', control: 'text', hint: 'Optional CLOUDFRONT-scope web ACL created in us-east-1 in the deployment account.' },
  ],
  build(values) {
    const findings            = [];
    const reject = (path        , message        ) => findings.push(error('aws.cloudfront.' + path, message, { path }));
    const location = String(values.aws_region ?? ''), name = String(values.name ?? '').trim(), bucket = String(values.bucket ?? ''), root = String(values.root ?? ''), price = String(values.price ?? ''), certificate = String(values.certificate ?? '').trim(), waf = String(values.waf ?? '').trim();
    const aliases = [...new Set(String(values.aliases ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))], accounts           = [];
    if (awsServicePartition(location) !== 'aws') reject('aws_region', 'This private-origin workflow supports the standard AWS partition. Other partitions require their qualified CloudFront deployment path.');
    if (!name || name.length > 128 || /[\r\n]/.test(name)) reject('name', 'Enter a description of 1–128 characters.');
    if (!validS3BucketName(bucket)) reject('bucket', 'Enter a valid unique new S3 bucket name.');
    if (!root || root.length > 255 || root.startsWith('/') || /[?#\r\n]/.test(root)) reject('root', 'Enter an object key up to 255 characters without a leading slash, query or fragment.');
    if (!['PriceClass_100', 'PriceClass_200', 'PriceClass_All'].includes(price)) reject('price', 'Select an edge price class.');
    if (aliases.length > 100 || aliases.some(host => host.length > 253 || !host.includes('.') || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) reject('aliases', 'Enter up to 100 valid ASCII or Punycode hostnames without wildcards.');
    if (aliases.length) {
      const parsed = /^arn:aws:acm:us-east-1:(\d{12}):certificate\/[a-f0-9-]+$/.exec(certificate);
      if (!parsed) reject('certificate', 'Use an issued ACM certificate ARN from us-east-1.');
      accounts.push(parsed?.[1] ?? '');
    }
    if (waf) {
      const parsed = /^arn:aws:wafv2:us-east-1:(\d{12}):global\/webacl\/[A-Za-z0-9_-]+\/[a-f0-9-]+$/.exec(waf);
      if (!parsed) reject('waf', 'Use a CLOUDFRONT-scope WAFv2 web ACL ARN from us-east-1.');
      accounts.push(parsed?.[1] ?? '');
    }
    return awsServiceModule(location, [
      dat('aws_caller_identity', 'current', {}), dat('aws_cloudfront_cache_policy', 'optimized', { name: 'Managed-CachingOptimized' }),
      res('aws_s3_bucket', 'content', { bucket, force_destroy: false }, [blk('lifecycle', { prevent_destroy: true })]),
      res('aws_s3_bucket_public_access_block', 'content', { bucket: x('aws_s3_bucket.content.id'), block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
      res('aws_s3_bucket_versioning', 'content', { bucket: x('aws_s3_bucket.content.id') }, [blk('versioning_configuration', { status: 'Enabled' })]),
      res('aws_s3_bucket_server_side_encryption_configuration', 'content', { bucket: x('aws_s3_bucket.content.id') }, [blk('rule', {}, [blk('apply_server_side_encryption_by_default', { sse_algorithm: 'AES256' })])]),
      res('aws_cloudfront_origin_access_control', 'content', { name: bucket, origin_access_control_origin_type: 's3', signing_behavior: 'always', signing_protocol: 'sigv4' }),
      res('aws_cloudfront_distribution', 'configured', { comment: name, enabled: true, is_ipv6_enabled: true, default_root_object: root, price_class: price, aliases, http_version: 'http2and3', wait_for_deployment: true, ...(waf ? { web_acl_id: waf } : {}) }, [
        blk('origin', { domain_name: x('aws_s3_bucket.content.bucket_regional_domain_name'), origin_id: 'private-s3', origin_access_control_id: x('aws_cloudfront_origin_access_control.content.id') }),
        blk('default_cache_behavior', { target_origin_id: 'private-s3', viewer_protocol_policy: 'redirect-to-https', allowed_methods: ['GET', 'HEAD', 'OPTIONS'], cached_methods: ['GET', 'HEAD'], compress: true, cache_policy_id: x('data.aws_cloudfront_cache_policy.optimized.id') }),
        blk('restrictions', {}, [blk('geo_restriction', { restriction_type: 'none' })]),
        blk('viewer_certificate', aliases.length ? { acm_certificate_arn: certificate, ssl_support_method: 'sni-only', minimum_protocol_version: 'TLSv1.2_2021' } : { cloudfront_default_certificate: true }),
        ...(accounts.length ? [blk('lifecycle', {}, [blk('precondition', { condition: x('alltrue([for account in ' + JSON.stringify(accounts) + ' : account == data.aws_caller_identity.current.account_id])'), error_message: 'Use the certificate and web ACL from the distribution account.' })])] : []),
      ]),
      res('aws_s3_bucket_policy', 'content', { bucket: x('aws_s3_bucket.content.id'), policy: x(jsonencode({ Version: '2012-10-17', Statement: [
        { Sid: 'DistributionRead', Effect: 'Allow', Principal: { Service: 'cloudfront.amazonaws.com' }, Action: 's3:GetObject', Resource: e('"${aws_s3_bucket.content.arn}/*"'), Condition: { StringEquals: { 'AWS:SourceArn': e('aws_cloudfront_distribution.configured.arn') } } },
        { Sid: 'RequireTls', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [e('aws_s3_bucket.content.arn'), e('"${aws_s3_bucket.content.arn}/*"')], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
      ] })) }),
      output('distribution_id', 'aws_cloudfront_distribution.configured.id'), output('distribution_domain', 'aws_cloudfront_distribution.configured.domain_name'), output('distribution_zone_id', 'aws_cloudfront_distribution.configured.hosted_zone_id'), output('content_bucket', 'aws_s3_bucket.content.id'),
    ], `# CloudFront with private S3 static content

## Prepare
Confirm the data owner permits the intended global edge delivery, origin location and caching behavior. This form supports the standard AWS partition, a new S3 REST origin and public viewer access to its static objects through CloudFront. The bucket remains private; origin access control is not viewer authentication. For custom hostnames, prepare an issued matching ACM certificate in us-east-1. Review price-class geography, WAF rules and any DNS/certificate ownership constraints.

## Implement
Run terraform init, terraform validate and terraform plan -out=service.tfplan. Review the content bucket, distribution-scoped origin policy, managed cache policy, HTTPS behavior and optional hostnames/WAF. Apply the saved plan. Upload the approved site files to content_bucket using a scoped deployment identity. No website content is bundled. Use versioned asset filenames and appropriate Cache-Control metadata; the managed caching-optimized policy is for cacheable static content.

## Verify
Wait for the distribution to deploy. Test the distribution hostname, HTTPS redirects, root object, assets and expected error responses. Confirm direct anonymous S3 object access is denied. Validate cache behavior and invalidation with changed test content. Create the custom DNS alias only after certificate and application tests pass. Confirm WAF behavior when attached. Single-page-app fallback routes, signed viewers, dynamic APIs, CORS and access logging require their corresponding additional configuration.

## Recovery
Keep the preceding site and DNS destination through cutover. Restore the previous S3 object versions or versioned release assets and invalidate affected cache paths when needed. Restore prior DNS routing if validation fails. Distribution changes and invalidations take time to propagate. The bucket has Terraform prevent_destroy and force deletion disabled; review retained object versions and data disposition before retirement.

https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
`, findings);
  },
}                    ;

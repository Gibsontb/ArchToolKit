/**
 * `<p>_app_static_site` (tier pattern `static-site`, addendum A.2.10): a
 * static web front end served from object storage.
 *
 *   AWS     a private S3 bucket behind CloudFront (origin access control,
 *           IPv6, HTTP/3, TLS 1.2+), Route 53 A / AAAA aliases
 *   Azure   Azure Static Web Apps (Standard) with its custom domains
 *   Google  a Cloud Storage bucket behind a global external Application load
 *           balancer with a backend bucket and Cloud CDN, on IPv4 and IPv6
 *           addresses, with a Google-managed certificate
 *   OCI     an Object Storage bucket readable without listing (OCI has no
 *           first-party CDN; put a load balancer or API gateway in front for
 *           TLS on the app's own name)
 *
 * The content is the pipeline's (it syncs the build output into the bucket).
 */

import { info,              } from '../../../core/findings.js';
                                                                                            
import { str as valueOf } from '../../../kit/blueprint.js';
                                             
import { LANDING_ZONE_SOURCE, blk, dat, e, hcl, jsonencode, lzRef, output, q, res, rname, variable, x,               } from '../migration/common.js';
import { PATTERN_GROUP, appInputs, appOf, listOf, namePrefix, patternMainTf, preamble, tagsExpr } from './common.js';

/** The regions Static Web Apps' own resource can be placed in (the content is served globally). */
const SWA_REGIONS = ['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'];

function staticInputs(platform          )                   {
  return [
    ...appInputs(),
    { id: 'fqdns', label: 'DNS names', control: 'text', default: 'www.example.com', hint: 'Space-separated custom domains; blank serves on the service\'s own name.' },
    ...(platform === 'aws'
      ? [
          { id: 'dns_zone', label: 'Route 53 zone', control: 'text'         , default: 'example.com', hint: 'The public zone of the names; blank writes no records.' },
          { id: 'certificate', label: 'ACM certificate (us-east-1)', control: 'text'         , default: '', hint: 'CloudFront reads certificates from us-east-1 only. Blank: a variable you supply.' },
          { id: 'price_class', label: 'Edge locations', control: 'select'         , default: 'PriceClass_100', options: [{ value: 'PriceClass_100', label: 'North America and Europe' }, { value: 'PriceClass_200', label: 'Most regions' }, { value: 'PriceClass_All', label: 'All edge locations' }] },
        ]
      : platform === 'azure'
        ? [{ id: 'swa_region', label: 'Static Web Apps region', control: 'select'         , default: 'westeurope', options: SWA_REGIONS.map((r) => ({ value: r, label: r })), hint: 'Where the resource sits; the content is served from the global edge.' }]
        : platform === 'google'
          ? [{ id: 'dns_zone', label: 'Cloud DNS zone name', control: 'text'         , default: '', hint: 'The managed zone of the names; blank writes no records.' }]
          : []),
    LANDING_ZONE_SOURCE,
  ];
}

function awsStatic(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const tags = x(tagsExpr(app, 'aws'));
  const fqdns = listOf(values, 'fqdns');
  const zone = valueOf(values, 'dns_zone');
  const cert = valueOf(values, 'certificate');
  const blocks             = [...preamble('aws', values)];
  if (fqdns.length > 0 && !cert) blocks.push(variable(`${app.id}_site_certificate`, 'string', `The ACM certificate ARN (us-east-1) for ${fqdns.join(', ')}.`));
  const certRef = cert ? q(cert) : `var.${app.id}_site_certificate`;
  blocks.push(
    res('aws_s3_bucket', 'site', { bucket_prefix: x(`substr("${pfx}-site-", 0, 37)`), force_destroy: false, tags }),
    res('aws_s3_bucket_public_access_block', 'site', { bucket: x('aws_s3_bucket.site.id'), block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
    res('aws_s3_bucket_ownership_controls', 'site', { bucket: x('aws_s3_bucket.site.id') }, [blk('rule', { object_ownership: 'BucketOwnerEnforced' })]),
    res('aws_s3_bucket_versioning', 'site', { bucket: x('aws_s3_bucket.site.id') }, [blk('versioning_configuration', { status: 'Enabled' })]),
    res('aws_s3_bucket_server_side_encryption_configuration', 'site', { bucket: x('aws_s3_bucket.site.id') }, [blk('rule', { bucket_key_enabled: true }, [blk('apply_server_side_encryption_by_default', { sse_algorithm: 'AES256' })])]),
    res('aws_cloudfront_origin_access_control', 'site', { name: x(`substr("${pfx}-site", 0, 64)`), origin_access_control_origin_type: 's3', signing_behavior: 'always', signing_protocol: 'sigv4' }),
    dat('aws_cloudfront_cache_policy', 'optimized', { name: 'Managed-CachingOptimized' }),
    dat('aws_cloudfront_response_headers_policy', 'security', { name: 'Managed-SecurityHeadersPolicy' }),
    res('aws_cloudfront_distribution', 'site', {
      enabled: true,
      is_ipv6_enabled: true,
      http_version: 'http2and3',
      comment: `${app.name} static site`,
      default_root_object: 'index.html',
      price_class: valueOf(values, 'price_class', 'PriceClass_100'),
      aliases: fqdns.length > 0 ? fqdns : undefined,
      tags,
    }, [
      blk('origin', { domain_name: x('aws_s3_bucket.site.bucket_regional_domain_name'), origin_id: 's3', origin_access_control_id: x('aws_cloudfront_origin_access_control.site.id') }),
      blk('default_cache_behavior', {
        target_origin_id: 's3',
        viewer_protocol_policy: 'redirect-to-https',
        allowed_methods: ['GET', 'HEAD', 'OPTIONS'],
        cached_methods: ['GET', 'HEAD'],
        compress: true,
        cache_policy_id: x('data.aws_cloudfront_cache_policy.optimized.id'),
        response_headers_policy_id: x('data.aws_cloudfront_response_headers_policy.security.id'),
      }),
      blk('custom_error_response', { error_code: 404, response_code: 404, response_page_path: '/404.html', error_caching_min_ttl: 60 }),
      blk('restrictions', {}, [blk('geo_restriction', { restriction_type: 'none' })]),
      fqdns.length > 0
        ? blk('viewer_certificate', { acm_certificate_arn: x(certRef), ssl_support_method: 'sni-only', minimum_protocol_version: 'TLSv1.2_2021' })
        : blk('viewer_certificate', { cloudfront_default_certificate: true }),
    ]),
    res('aws_s3_bucket_policy', 'site', {
      bucket: x('aws_s3_bucket.site.id'),
      policy: x(jsonencode({
        Version: '2012-10-17',
        Statement: [{
          Sid: 'CloudFrontRead',
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 's3:GetObject',
          Resource: e('"${aws_s3_bucket.site.arn}/*"'),
          Condition: { StringEquals: { 'AWS:SourceArn': e('aws_cloudfront_distribution.site.arn') } },
        }],
      })),
      depends_on: x('[aws_s3_bucket_public_access_block.site]'),
    }),
  );
  if (zone && fqdns.length > 0) {
    const names = fqdns.filter((f) => f === zone || f.endsWith(`.${zone}`));
    const alias = blk('alias', { name: x('aws_cloudfront_distribution.site.domain_name'), zone_id: x('aws_cloudfront_distribution.site.hosted_zone_id'), evaluate_target_health: false });
    blocks.push(
      dat('aws_route53_zone', 'site', { name: zone, private_zone: false }),
      res('aws_route53_record', 'site_a', { for_each: x(`toset(${hcl(names)})`), zone_id: x('data.aws_route53_zone.site.zone_id'), name: x('each.value'), type: 'A' }, [alias]),
      res('aws_route53_record', 'site_aaaa', { for_each: x(`toset(${hcl(names)})`), zone_id: x('data.aws_route53_zone.site.zone_id'), name: x('each.value'), type: 'AAAA' }, [alias]),
    );
  }
  findings.push(info('tf.app.static-sse', 'The bucket uses S3-managed encryption: CloudFront reads a KMS-encrypted origin only when the key policy grants it.', { source: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html' }));
  blocks.push(output('bucket', 'aws_s3_bucket.site.id', 'Where the pipeline syncs the build output.'), output('distribution_domain', 'aws_cloudfront_distribution.site.domain_name'));
  return blocks;
}

function azureStatic(values                 )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const tags = x(tagsExpr(app, 'azure'));
  const fqdns = listOf(values, 'fqdns');
  return [
    ...preamble('azure', values),
    res('azurerm_static_web_app', 'site', {
      name: x(`"${pfx}-site"`),
      resource_group_name: x(`${lz}.resource_group["shared"]`),
      location: valueOf(values, 'swa_region', 'westeurope'),
      sku_tier: 'Standard',
      sku_size: 'Standard',
      public_network_access_enabled: true,
      tags,
    }),
    ...fqdns.map((f) => res('azurerm_static_web_app_custom_domain', rname(f).replace(/-/g, '_'), { static_web_app_id: x('azurerm_static_web_app.site.id'), domain_name: f, validation_type: 'cname-delegation' }, [], `${f}: a CNAME to the site's default host name has to exist first.`)),
    output('default_host_name', 'azurerm_static_web_app.site.default_host_name'),
    output('api_key', 'azurerm_static_web_app.site.api_key', 'The deployment token the pipeline uses (sensitive).', true),
  ];
}

function googleStatic(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  const project = `${lz}.project`;
  const fqdns = listOf(values, 'fqdns');
  const zone = valueOf(values, 'dns_zone');
  const labels = x(tagsExpr(app, 'google'));
  const blocks             = [
    ...preamble('google', values),
    res('google_storage_bucket', 'site', {
      name: x(`"${pfx}-site"`),
      project: x(project),
      location: x(`upper(${lz}.region)`),
      uniform_bucket_level_access: true,
      public_access_prevention: 'inherited',
      force_destroy: false,
      labels,
    }, [blk('website', { main_page_suffix: 'index.html', not_found_page: '404.html' }), blk('versioning', { enabled: true })]),
    res('google_storage_bucket_iam_member', 'site_public', { bucket: x('google_storage_bucket.site.name'), role: 'roles/storage.objectViewer', member: 'allUsers' }, [], 'A public site: everyone may read its objects (the organisation policy must allow allUsers).'),
    res('google_compute_backend_bucket', 'site', { name: x(`"${pfx}-site"`), project: x(project), bucket_name: x('google_storage_bucket.site.name'), enable_cdn: true }, [
      blk('cdn_policy', { cache_mode: 'CACHE_ALL_STATIC', default_ttl: 3600, client_ttl: 3600, max_ttl: 86400, serve_while_stale: 86400 }),
    ]),
    res('google_compute_url_map', 'site', { name: x(`"${pfx}-site"`), project: x(project), default_service: x('google_compute_backend_bucket.site.id') }),
    res('google_compute_global_address', 'site_v4', { name: x(`"${pfx}-site-v4"`), project: x(project), ip_version: 'IPV4' }),
    res('google_compute_global_address', 'site_v6', { name: x(`"${pfx}-site-v6"`), project: x(project), ip_version: 'IPV6' }),
  ];
  let proxy        ;
  if (fqdns.length > 0) {
    blocks.push(
      res('google_compute_managed_ssl_certificate', 'site', { name: x(`"${pfx}-site"`), project: x(project) }, [blk('managed', { domains: fqdns })]),
      res('google_compute_target_https_proxy', 'site', { name: x(`"${pfx}-site"`), project: x(project), url_map: x('google_compute_url_map.site.id'), ssl_certificates: x('[google_compute_managed_ssl_certificate.site.id]') }),
    );
    proxy = 'google_compute_target_https_proxy.site.id';
  } else {
    findings.push(info('tf.app.static-gcp-http', 'No DNS name was given, so the site is served over HTTP on its addresses; add a name for a managed certificate and HTTPS.', { path: 'fqdns' }));
    blocks.push(res('google_compute_target_http_proxy', 'site', { name: x(`"${pfx}-site"`), project: x(project), url_map: x('google_compute_url_map.site.id') }));
    proxy = 'google_compute_target_http_proxy.site.id';
  }
  for (const fam of ['v4', 'v6']) {
    blocks.push(
      res('google_compute_global_forwarding_rule', `site_${fam}`, {
        name: x(`"${pfx}-site-${fam}"`),
        project: x(project),
        load_balancing_scheme: 'EXTERNAL_MANAGED',
        ip_address: x(`google_compute_global_address.site_${fam}.id`),
        ip_protocol: 'TCP',
        port_range: fqdns.length > 0 ? '443' : '80',
        target: x(proxy),
        labels,
      }),
    );
  }
  if (zone && fqdns.length > 0) {
    blocks.push(
      res('google_dns_record_set', 'site_a', { for_each: x(`toset(${hcl(fqdns)})`), project: x(project), managed_zone: zone, name: x('"${each.value}."'), type: 'A', ttl: 300, rrdatas: x('[google_compute_global_address.site_v4.address]') }),
      res('google_dns_record_set', 'site_aaaa', { for_each: x(`toset(${hcl(fqdns)})`), project: x(project), managed_zone: zone, name: x('"${each.value}."'), type: 'AAAA', ttl: 300, rrdatas: x('[google_compute_global_address.site_v6.address]') }),
    );
  }
  blocks.push(output('bucket', 'google_storage_bucket.site.name', 'Where the pipeline syncs the build output.'), output('address_v4', 'google_compute_global_address.site_v4.address'), output('address_v6', 'google_compute_global_address.site_v6.address'));
  return blocks;
}

function ociStatic(values                 , findings           )             {
  const app = appOf(values);
  const lz = lzRef(values);
  const pfx = namePrefix(values, app);
  findings.push(info('tf.app.static-oci', 'OCI has no first-party CDN or static-site service: the bucket serves its objects on the Object Storage endpoint; put an OCI load balancer or API gateway in front for TLS on the app\'s own name (verify).', { path: 'fqdns' }));
  return [
    ...preamble('oci', values),
    dat('oci_objectstorage_namespace', 'site', { compartment_id: x(`${lz}.compartment_id`) }),
    res('oci_objectstorage_bucket', 'site', {
      compartment_id: x(`${lz}.compartment_id`),
      namespace: x('data.oci_objectstorage_namespace.site.namespace'),
      name: x(`"${pfx}-site"`),
      access_type: 'ObjectReadWithoutList',
      versioning: 'Enabled',
      storage_tier: 'Standard',
      freeform_tags: x(tagsExpr(app, 'oci')),
    }),
    output('site_url', `"https://objectstorage.\${${lz}.region}.oraclecloud.com/n/\${data.oci_objectstorage_namespace.site.namespace}/b/\${oci_objectstorage_bucket.site.name}/o/index.html"`),
  ];
}

const EMITS                                                = {
  aws: [
    'aws_s3_bucket', 'aws_s3_bucket_public_access_block', 'aws_s3_bucket_ownership_controls', 'aws_s3_bucket_versioning', 'aws_s3_bucket_server_side_encryption_configuration',
    'aws_cloudfront_origin_access_control', 'aws_cloudfront_distribution', 'aws_s3_bucket_policy', 'aws_route53_record',
  ],
  azure: ['azurerm_static_web_app', 'azurerm_static_web_app_custom_domain'],
  google: [
    'google_storage_bucket', 'google_storage_bucket_iam_member', 'google_compute_backend_bucket', 'google_compute_url_map', 'google_compute_global_address',
    'google_compute_managed_ssl_certificate', 'google_compute_target_https_proxy', 'google_compute_target_http_proxy', 'google_compute_global_forwarding_rule', 'google_dns_record_set',
  ],
  oci: ['oci_objectstorage_bucket'],
};
const SERVICE                                     = { aws: 'Amazon S3 and CloudFront', azure: 'Azure Static Web Apps', google: 'Cloud Storage and Cloud CDN', oci: 'OCI Object Storage' };

function staticSite(platform          )            {
  return {
    id: `${platform}_app_static_site`,
    label: `App static site on ${SERVICE[platform]}`,
    group: PATTERN_GROUP,
    description: {
      aws: 'A private, versioned S3 bucket read only by CloudFront (origin access control), a distribution on IPv4 and IPv6 with HTTP/3, TLS 1.2+ and security headers, and Route 53 A / AAAA aliases for the names.',
      azure: 'An Azure Static Web Apps site (Standard) with its custom domains, validated by CNAME delegation; the deployment token is an output for the pipeline.',
      google: 'A versioned Cloud Storage bucket served through a backend bucket with Cloud CDN on a global external Application load balancer, IPv4 and IPv6 addresses, a Google-managed certificate and Cloud DNS records.',
      oci: 'A versioned Object Storage bucket whose objects can be read (not listed) on the Object Storage endpoint.',
    }[platform],
    inputs: staticInputs(platform),
    emits: EMITS[platform],
    build: (values                 ) => {
      const findings            = [];
      const blocks =
        platform === 'aws' ? awsStatic(values, findings)
        : platform === 'azure' ? azureStatic(values)
        : platform === 'google' ? googleStatic(values, findings)
        : ociStatic(values, findings);
      return { files: { 'main.tf': patternMainTf(blocks, `${SERVICE[platform]}: ${appOf(values).name}`) }, findings };
    },
  };
}

export const STATIC_SITE_BLUEPRINTS                       = (['aws', 'azure', 'google', 'oci']         ).map(staticSite);

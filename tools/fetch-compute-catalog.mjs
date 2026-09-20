#!/usr/bin/env node
/**
 * Regenerates src/kit/sizes-data.ts — the machine catalogues.
 *
 * Two kinds of input, because the vendors publish two kinds of thing.
 *
 * AWS publishes an enum. The `InstanceType` shape in the EC2 API model is the
 * list the API itself validates against, so it is exact and it is complete, and
 * reading it beats scraping a page about it. It ships inside botocore:
 *
 *     git clone --depth 1 --filter=blob:none --no-checkout \
 *       https://github.com/boto/botocore.git /tmp/botocore
 *     cd /tmp/botocore && git sparse-checkout init --cone \
 *       && git sparse-checkout set botocore/data/ec2 && git checkout
 *     node tools/fetch-compute-catalog.mjs --botocore /tmp/botocore
 *
 * Without --botocore the AWS list already in sizes-data.ts is kept, so running
 * this to refresh one of the others does not quietly empty it.
 *
 * The other three publish prose. Azure, GCP and OCI name their series and the
 * vCPU counts each one comes in, and the size names are that crossed together —
 * Standard_D<n>as_v5, n2-standard-<n>. So the ladders are the input here,
 * written out below with the page they came from, and the crossing is done in
 * code. That is the honest shape of it: a scraper over those pages would be a
 * scraper over a table of RAM figures that happens to have the names in it.
 *
 * Which means refreshing Azure/GCP/OCI is an edit to the LADDERS below, not a
 * fetch. Check the pages named against each one, add the new series, run this.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/kit/sizes-data.ts');

// ---------------------------------------------------------------- AWS ------

/**
 * Instance family to the category AWS files it under, from
 * docs.aws.amazon.com/ec2/latest/instancetypes/{gp,co,mo,so,ac,hpc}.html
 * plus the previous-generation families those pages no longer list.
 */
const AWS_FAMILIES = {
  'General purpose':
    'a1,m1,m3,m4,m5,m5a,m5ad,m5d,m5dn,m5n,m5zn,m6a,m6g,m6gd,m6i,m6id,m6idn,m6in,m7a,m7g,m7gd,' +
    'm7i,m7i-flex,m8a,m8azn,m8g,m8gb,m8gd,m8gn,m8i,m8id,m8i-flex,m8in,m8idn,m8ine,m8ib,m8idb,' +
    'm9g,m9gd,mac1,mac2,mac2-m1ultra,mac2-m2,mac2-m2pro,mac-m3ultra,mac-m4,mac-m4pro,mac-m4max,' +
    't1,t2,t3,t3a,t4g,t8i',
  'Compute optimized':
    'c1,c3,c4,c5,c5a,c5ad,c5d,c5n,c6a,c6g,c6gd,c6gn,c6i,c6id,c6in,c7a,c7g,c7gd,c7gn,c7i,c7i-flex,' +
    'c8a,c8g,c8gb,c8gd,c8gn,c8i,c8id,c8i-flex,c8in,c8ine,c8ib,c9g,c9gd,cc1,cc2',
  'Memory optimized':
    'cr1,m2,r3,r4,r5,r5a,r5ad,r5b,r5d,r5dn,r5n,r6a,r6g,r6gd,r6i,r6id,r6idn,r6in,r7a,r7g,r7gd,r7i,' +
    'r7iz,r8a,r8g,r8gb,r8gd,r8gn,r8i,r8id,r8i-flex,r8in,r8idn,r8ib,r8idb,r9g,r9gd,u-3tb1,u-6tb1,' +
    'u-9tb1,u-12tb1,u-18tb1,u-24tb1,u7i-6tb,u7i-8tb,u7i-12tb,u7ib-12tb,u7in-16tb,u7in-24tb,' +
    'u7in-32tb,u7inh-32tb,x1,x1e,x2gd,x2idn,x2iedn,x2iezn,x8g,x8aedz,x8i,z1d',
  'Storage optimized':
    'd2,d3,d3en,h1,hi1,hs1,i2,i3,i3en,i4g,i4i,i7i,i7ie,i8g,i8ge,im4gn,is4gen',
  'Accelerated computing':
    'cg1,dl1,dl2q,f1,f2,g2,g3,g3s,g4ad,g4dn,g5,g5g,g6,g6e,g6f,gr6,gr6f,g7,g7e,inf1,inf2,p2,p3,' +
    'p3dn,p4d,p4de,p5,p5e,p5en,p6-b200,p6-b300,p6e-gb200,trn1,trn1n,trn2,trn2u,vt1',
  'HPC optimized': 'hpc6a,hpc6id,hpc7a,hpc7g,hpc8a',
};

const AWS_CATEGORY_ORDER = [
  'General purpose',
  'Compute optimized',
  'Memory optimized',
  'Storage optimized',
  'Accelerated computing',
  'HPC optimized',
  'Other',
];

/** The EC2 families RDS offers, with the sizes it offers them in. */
const RDS_LADDER = ['large', 'xlarge', '2xlarge', '4xlarge', '8xlarge', '12xlarge', '16xlarge', '24xlarge'];
const RDS_BURSTABLE = ['micro', 'small', 'medium', 'large', 'xlarge', '2xlarge'];
const RDS_FAMILIES = {
  Burstable: { sizes: RDS_BURSTABLE, families: ['t2', 't3', 't4g'] },
  Standard: { sizes: RDS_LADDER, families: ['m4', 'm5', 'm5d', 'm6i', 'm6g', 'm6gd', 'm7g', 'm7i', 'm8g'] },
  'Memory optimized': {
    sizes: RDS_LADDER,
    families: ['r4', 'r5', 'r5b', 'r5d', 'r6i', 'r6g', 'r6gd', 'r7g', 'r7i', 'r8g', 'x2g', 'x2i', 'z1d'],
  },
};

// -------------------------------------------------------------- ladders ----

/** Azure: learn.microsoft.com/en-us/azure/virtual-machines/sizes/overview */
const AZURE = () => {
  const s = (prefix, ns, suffix = '') => ns.map((n) => `Standard_${prefix}${n}${suffix}`);
  const D5 = [2, 4, 8, 16, 32, 48, 64, 96];
  const D5L = [2, 4, 8, 16, 32, 48, 64];
  const D6 = [2, 4, 8, 16, 32, 48, 64, 96, 128];
  const D6A = [2, 4, 8, 16, 32, 48, 64, 96];
  const E5 = [2, 4, 8, 16, 20, 32, 48, 64, 96, 104];
  const B2 = [2, 4, 8, 16, 32];

  const general = [
    ...['B1ls', 'B1s', 'B1ms', 'B2s', 'B2ms', 'B4ms', 'B8ms', 'B12ms', 'B16ms', 'B20ms'].map((x) => `Standard_${x}`),
    ...B2.flatMap((n) => [`Standard_B${n}ls_v2`, `Standard_B${n}s_v2`]),
    'Standard_B2ts_v2',
    ...B2.flatMap((n) => [`Standard_B${n}als_v2`, `Standard_B${n}as_v2`]),
    ...['_v5', 's_v5', 'd_v5', 'ds_v5', 'as_v5', 'ads_v5'].flatMap((suf) => s('D', D5, suf)),
    ...['ls_v5', 'lds_v5', 'ps_v5', 'pds_v5', 'pls_v5', 'plds_v5'].flatMap((suf) => s('D', D5L, suf)),
    ...['s_v6', 'ds_v6', 'ls_v6', 'lds_v6'].flatMap((suf) => s('D', D6, suf)),
    ...['as_v6', 'ads_v6', 'als_v6', 'alds_v6'].flatMap((suf) => s('D', D6A, suf)),
    ...s('A', [1, 2, 4, 8], '_v2'),
    ...s('A', [2, 4, 8], 'm_v2'),
    ...s('DS', [1, 2, 3, 4, 5], '_v2'),
    ...s('D', [1, 2, 3, 4, 5], '_v2'),
    ...['_v3', 's_v3'].flatMap((suf) => s('D', [2, 4, 8, 16, 32, 64], suf)),
    ...['a_v4', 'as_v4'].flatMap((suf) => s('D', [2, 4, 8, 16, 32, 48, 64, 96], suf)),
  ];

  const compute = [
    ...s('F', [2, 4, 8, 16, 32, 48, 64, 72], 's_v2'),
    ...[1, 2, 4, 8, 16].flatMap((n) => [`Standard_F${n}`, `Standard_F${n}s`]),
    ...['as_v6', 'ads_v6', 'als_v6', 'alds_v6', 'ams_v6', 'amds_v6'].flatMap((suf) => s('F', D5L, suf)),
    ...s('FX', [4, 12, 24, 36, 48], 'mds'),
  ];

  const memory = [
    ...['_v5', 's_v5', 'd_v5', 'ds_v5'].flatMap((suf) => s('E', E5, suf)),
    ...['as_v5', 'ads_v5'].flatMap((suf) => s('E', [2, 4, 8, 16, 20, 32, 48, 64, 96], suf)),
    ...['ps_v5', 'pds_v5'].flatMap((suf) => s('E', [2, 4, 8, 16, 20], suf)),
    ...['s_v6', 'ds_v6'].flatMap((suf) => s('E', [2, 4, 8, 16, 20, 32, 48, 64, 96, 128], suf)),
    ...['as_v6', 'ads_v6', 'bs_v5', 'bds_v5'].flatMap((suf) => s('E', D6A, suf)),
    ...['_v3', 's_v3'].flatMap((suf) => s('E', [2, 4, 8, 16, 20, 32, 64], suf)),
    ...['M8ms', 'M16ms', 'M32ts', 'M32ls', 'M32ms', 'M64', 'M64s', 'M64ls', 'M64ms', 'M128', 'M128s', 'M128ms',
      'M32ms_v2', 'M64s_v2', 'M64ms_v2', 'M128s_v2', 'M128ms_v2', 'M192is_v2', 'M192ims_v2',
      'M208s_v2', 'M208ms_v2', 'M416s_v2', 'M416ms_v2',
      'M12s_v3', 'M24s_v3', 'M48s_v3', 'M96s_v3', 'M176s_v3', 'M624ds_v3', 'M832ds_v3'].map((x) => `Standard_${x}`),
  ];

  const storage = [
    ...['s_v3', 'as_v3', 's_v4', 'as_v4'].flatMap((suf) => s('L', [8, 16, 32, 48, 64, 80], suf)),
    ...s('L', [4, 8, 16, 32], 's'),
    ...s('L', [8, 16, 32, 48, 64, 80], 's_v2'),
  ];

  const gpu = ['NC4as_T4_v3', 'NC8as_T4_v3', 'NC16as_T4_v3', 'NC64as_T4_v3',
    'NC6s_v3', 'NC12s_v3', 'NC24s_v3', 'NC24rs_v3',
    'NC24ads_A100_v4', 'NC48ads_A100_v4', 'NC96ads_A100_v4',
    'NC40ads_H100_v5', 'NC80adis_H100_v5',
    'ND96asr_v4', 'ND96amsr_A100_v4', 'ND96isr_H100_v5', 'ND96isr_H200_v5',
    'NV6', 'NV12', 'NV24', 'NV12s_v3', 'NV24s_v3', 'NV48s_v3',
    'NV4as_v4', 'NV8as_v4', 'NV16as_v4', 'NV32as_v4',
    'NV6ads_A10_v5', 'NV12ads_A10_v5', 'NV18ads_A10_v5',
    'NV36ads_A10_v5', 'NV36adms_A10_v5', 'NV72ads_A10_v5'].map((x) => `Standard_${x}`);

  const hpc = ['HB120rs_v2', 'HB120rs_v3', 'HB120-96rs_v3', 'HB120-64rs_v3', 'HB120-32rs_v3', 'HB120-16rs_v3',
    'HB176rs_v4', 'HB176-144rs_v4', 'HB176-96rs_v4', 'HB176-48rs_v4', 'HB176-24rs_v4',
    'HC44rs', 'HC44-32rs', 'HC44-16rs',
    'HX176rs', 'HX176-144rs', 'HX176-96rs', 'HX176-48rs', 'HX176-24rs'].map((x) => `Standard_${x}`);

  return {
    'General purpose': general,
    'Compute optimized': compute,
    'Memory optimized': memory,
    'Storage optimized': storage,
    'GPU accelerated': gpu,
    HPC: hpc,
  };
};

/** GCP: docs.cloud.google.com/compute/docs/machine-resource */
const GCP = () => {
  const mt = (series, kinds) =>
    Object.entries(kinds).flatMap(([kind, ns]) => ns.map((n) => `${series}-${kind}-${n}`));
  const n2 = [2, 4, 8, 16, 32, 48, 64, 80, 96, 128];
  const n2d = [2, 4, 8, 16, 32, 48, 64, 80, 96, 128, 224];
  const n4 = [2, 4, 8, 16, 32, 48, 64, 80];
  const c2d = [2, 4, 8, 16, 32, 56, 112];
  const c3 = [4, 8, 22, 44, 88, 176];
  const c3d = [4, 8, 16, 30, 60, 90, 180, 360];
  const c4 = [2, 4, 8, 16, 32, 48, 96, 192];
  const c4a = [1, 2, 4, 8, 16, 32, 48, 64, 72];
  const c4d = [2, 4, 8, 16, 32, 48, 64, 96, 192, 384];
  const all = (ns) => ({ standard: ns, highmem: ns, highcpu: ns });

  return {
    'General purpose': [
      'e2-micro', 'e2-small', 'e2-medium',
      ...mt('e2', { standard: [2, 4, 8, 16, 32], highmem: [2, 4, 8, 16], highcpu: [2, 4, 8, 16, 32] }),
      'f1-micro', 'g1-small',
      ...mt('n1', { standard: [1, 2, 4, 8, 16, 32, 64, 96], highmem: [2, 4, 8, 16, 32, 64, 96], highcpu: [2, 4, 8, 16, 32, 64, 96] }),
      ...mt('n2', { standard: n2, highmem: n2, highcpu: n2.slice(0, 9) }),
      ...mt('n2d', { standard: n2d, highmem: n2d.slice(0, 9), highcpu: n2d }),
      ...mt('n4', all(n4)),
      ...mt('t2d', { standard: [1, 2, 4, 8, 16, 32, 48, 60] }),
      ...mt('t2a', { standard: [1, 2, 4, 8, 16, 32, 48] }),
    ],
    'Compute optimized': [
      ...mt('c2', { standard: [4, 8, 16, 30, 60] }),
      ...mt('c2d', all(c2d)),
      ...mt('c3', all(c3)),
      ...mt('c3d', all(c3d)),
      ...mt('c4', all(c4)),
      ...mt('c4a', all(c4a)),
      ...mt('c4d', all(c4d)),
      ...mt('h3', { standard: [88] }),
    ],
    'Memory optimized': [
      ...mt('m1', { ultramem: [40, 80, 160], megamem: [96] }),
      ...mt('m2', { ultramem: [208, 416], megamem: [416], hypermem: [416] }),
      ...mt('m3', { ultramem: [32, 64, 128], megamem: [64, 128] }),
      ...mt('m4', { ultramem: [224], megamem: [28, 56, 112, 224] }),
      ...mt('x4', { megamem: [960, 1440, 1920] }),
    ],
    'Storage optimized': mt('z3', { highmem: [88, 176] }),
    Accelerated: [
      'a2-highgpu-1g', 'a2-highgpu-2g', 'a2-highgpu-4g', 'a2-highgpu-8g', 'a2-megagpu-16g',
      'a2-ultragpu-1g', 'a2-ultragpu-2g', 'a2-ultragpu-4g', 'a2-ultragpu-8g',
      'a3-highgpu-1g', 'a3-highgpu-2g', 'a3-highgpu-4g', 'a3-highgpu-8g', 'a3-megagpu-8g',
      'a3-edgegpu-8g', 'a3-ultragpu-8g', 'a4-highgpu-8g',
      ...mt('g2', { standard: [4, 8, 12, 16, 24, 32, 48, 96] }),
    ],
  };
};

/** OCI: docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm */
const OCI = () => ({
  'Flexible (AMD)': ['VM.Standard.E6.Flex', 'VM.Standard.E5.Flex', 'VM.Standard.E4.Flex', 'VM.Standard.E3.Flex'],
  'Flexible (Arm)': ['VM.Standard.A4.Flex', 'VM.Standard.A4.Ax.Flex', 'VM.Standard.A2.Flex', 'VM.Standard.A1.Flex', 'VM.Standard.E6.Ax.Flex'],
  'Flexible (Intel)': ['VM.Standard4.Ax.Flex', 'VM.Standard3.Flex', 'VM.Optimized3.Flex'],
  'Dense I/O': ['VM.DenseIO.E6.Ax.Flex', 'VM.DenseIO.E5.Flex', 'VM.DenseIO.E4.Flex',
    'VM.DenseIO2.8', 'VM.DenseIO2.16', 'VM.DenseIO2.24',
    'VM.DenseIO1.4', 'VM.DenseIO1.8', 'VM.DenseIO1.16'],
  GPU: ['VM.GPU.A10.1', 'VM.GPU.A10.2', 'VM.GPU3.1', 'VM.GPU3.2', 'VM.GPU3.4', 'VM.GPU2.1'],
  Fixed: ['VM.Standard.E2.1.Micro', 'VM.Standard.E2.1', 'VM.Standard.E2.2', 'VM.Standard.E2.4', 'VM.Standard.E2.8',
    'VM.Standard2.1', 'VM.Standard2.2', 'VM.Standard2.4', 'VM.Standard2.8', 'VM.Standard2.16', 'VM.Standard2.24',
    'VM.Standard1.1', 'VM.Standard1.2', 'VM.Standard1.4', 'VM.Standard1.8', 'VM.Standard1.16',
    'VM.Standard.B1.1', 'VM.Standard.B1.2', 'VM.Standard.B1.4', 'VM.Standard.B1.8', 'VM.Standard.B1.16'],
  'Bare metal': ['BM.Standard.E6.256', 'BM.Standard.E5.192', 'BM.Standard.E4.128', 'BM.Standard.E3.128',
    'BM.Standard.A1.160', 'BM.Standard3.64', 'BM.Standard2.52', 'BM.Optimized3.36',
    'BM.DenseIO.E5.128', 'BM.DenseIO.E4.128', 'BM.DenseIO2.52',
    'BM.GPU.H100.8', 'BM.GPU.A100-v2.8', 'BM.GPU4.8', 'BM.GPU3.8', 'BM.GPU2.2', 'BM.HPC2.36'],
});

// ---------------------------------------------------------------- build ----

const SIZE_RANK = { nano: 0, micro: 1, small: 2, medium: 3, large: 4, xlarge: 5 };

function sizeKey(size) {
  if (size in SIZE_RANK) return [SIZE_RANK[size], 0, ''];
  const m = /^(\d+)xlarge$/.exec(size);
  if (m) return [5, Number(m[1]), ''];
  if (size.startsWith('metal')) return [900, 0, size];
  return [500, 0, size];
}

function famKey(fam) {
  const m = /^([a-z]+)(\d*)(.*)$/.exec(fam) ?? [fam, fam, '', ''];
  return [m[1], Number(m[2] || 0), m[3]];
}

function cmp(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function awsGroups(botocoreDir) {
  const base = join(botocoreDir, 'botocore/data/ec2');
  const versions = readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const model = JSON.parse(readFileSync(join(base, versions[versions.length - 1], 'service-2.json'), 'utf8'));
  const types = model.shapes.InstanceType?.enum;
  if (!Array.isArray(types)) throw new Error('No InstanceType enum in the EC2 model');

  const famToCat = new Map();
  for (const [cat, list] of Object.entries(AWS_FAMILIES)) {
    for (const fam of list.split(',')) famToCat.set(fam, cat);
  }

  const rows = new Map();
  const unknown = new Set();
  for (const type of types) {
    const dot = type.indexOf('.');
    const fam = dot === -1 ? type : type.slice(0, dot);
    const size = dot === -1 ? '' : type.slice(dot + 1);
    const cat = famToCat.get(fam);
    if (cat === undefined) unknown.add(fam);
    const key = cat ?? 'Other';
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push([fam, size, type]);
  }
  if (unknown.size > 0) {
    console.warn(`  note: ${unknown.size} families not in AWS_FAMILIES, filed under "Other": ${[...unknown].join(', ')}`);
  }

  const out = {};
  for (const cat of AWS_CATEGORY_ORDER) {
    const list = rows.get(cat);
    if (!list) continue;
    list.sort((a, b) => cmp(famKey(a[0]), famKey(b[0])) || cmp(sizeKey(a[1]), sizeKey(b[1])));
    out[cat] = list.map((r) => r[2]);
  }
  return out;
}

function rdsGroups() {
  const out = {};
  for (const [group, { sizes, families }] of Object.entries(RDS_FAMILIES)) {
    out[group] = families.flatMap((f) => sizes.map((s) => `db.${f}.${s}`));
  }
  return out;
}

function dedupe(groups) {
  const out = {};
  for (const [group, values] of Object.entries(groups)) {
    const seen = new Set();
    out[group] = values.filter((v) => (seen.has(v) ? false : (seen.add(v), true)));
  }
  return out;
}

function emit(name, groups, doc) {
  const total = Object.values(groups).reduce((n, v) => n + v.length, 0);
  const lines = [`/** ${total.toLocaleString('en-US')} ${doc} */`, `export const ${name}: GroupedValues = {`];
  for (const [group, values] of Object.entries(groups)) {
    lines.push(`  ${JSON.stringify(group)}: ${JSON.stringify(values.join(','))},`);
  }
  lines.push('};');
  return { text: lines.join('\n'), total };
}

/** The AWS block already in the file, for a run without --botocore. */
function existingAwsBlock() {
  const current = readFileSync(OUT, 'utf8');
  const start = current.indexOf('/** 1');
  const marker = current.indexOf('export const AWS_INSTANCE_TYPE_GROUPS');
  if (marker === -1) throw new Error('No AWS block to keep; pass --botocore');
  const end = current.indexOf('\n};', marker) + 3;
  return current.slice(start === -1 || start > marker ? marker : start, end);
}

function main() {
  const argv = process.argv.slice(2);
  const botocoreIdx = argv.indexOf('--botocore');
  const botocore = botocoreIdx === -1 ? null : argv[botocoreIdx + 1];

  const today = new Date().toISOString().slice(0, 10);
  const blocks = [];

  if (botocore) {
    const aws = awsGroups(botocore);
    const { text, total } = emit('AWS_INSTANCE_TYPE_GROUPS', aws, "EC2 instance types, grouped by AWS's own categories.");
    console.log(`  AWS    ${String(total).padStart(5)}  from ${botocore}`);
    blocks.push(text);
  } else {
    console.log('  AWS        —  kept (pass --botocore <dir> to refresh)');
    blocks.push(existingAwsBlock());
  }

  for (const [label, name, groups, doc] of [
    ['RDS', 'AWS_DB_INSTANCE_CLASS_GROUPS', rdsGroups(), 'RDS instance classes.'],
    ['Azure', 'AZURE_VM_SIZE_GROUPS', dedupe(AZURE()), 'Azure VM sizes.'],
    ['GCP', 'GCP_MACHINE_TYPE_GROUPS', dedupe(GCP()), 'Compute Engine predefined machine types.'],
    ['OCI', 'OCI_SHAPE_GROUPS', dedupe(OCI()), 'OCI compute shapes.'],
  ]) {
    const { text, total } = emit(name, groups, doc);
    console.log(`  ${label.padEnd(6)} ${String(total).padStart(5)}`);
    blocks.push(text);
  }

  const header = readFileSync(OUT, 'utf8').split('export const AWS_INSTANCE_TYPE_GROUPS')[0];
  const kept = header.slice(0, header.lastIndexOf('/**'));
  const dated = kept.replace(/export const SIZES_FETCHED_AT = '[^']*';/, `export const SIZES_FETCHED_AT = '${today}';`);
  writeFileSync(OUT, `${dated}${blocks.join('\n\n')}\n`);
  console.log(`\nWrote ${OUT}`);
}

main();

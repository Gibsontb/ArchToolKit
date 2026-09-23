/**
 * The VCF Operations for Logs, VCF Operations for Networks and fleet blueprints
 * (SDDC Manager, 9.1 fleet management, tags) have to emit files their target
 * takes as they stand. These checks build every one of them with every select
 * option and every toggle flipped, and hold the output to the formats the
 * products document:
 *
 *   - every blueprint has an IMPORT.md, and every file under import/ is named in it;
 *   - every .json and .vlcp parses; every .vlcp has the top-level keys, element
 *     shapes and extracted-field encoding of the published content packs;
 *   - the tag standard's PowerCLI CSV has exactly Category,Cardinality,
 *     EntityType,Tag,Description, and the vCenter REST bodies exactly the create
 *     spec fields;
 *   - request bodies have no wrapper the endpoint does not take;
 *   - every payload a script sends exists beside it.
 */

import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { defaultValues, type BlueprintValues } from '../kit/blueprint.ts';
import { LOGS_AUTOMATIONS, NETWORKS_AUTOMATIONS, vlcpInternalName } from './blueprints/vcf-networks-logs.ts';
import { LOGS_MORE, NETWORKS_MORE } from './blueprints/vcf-logs-networks-more.ts';
import { VCF_FLEET } from './blueprints/vcf-fleet.ts';
import { VCF_FLEET_91 } from './blueprints/vcf-fleet-91.ts';
import { VCF_TAGS } from './blueprints/vcf-tags.ts';

/** The blueprints of these five files; other Logs and Networks files have their own tests. */
const MINE = [...NETWORKS_AUTOMATIONS, ...LOGS_AUTOMATIONS, ...LOGS_MORE, ...NETWORKS_MORE, ...VCF_FLEET, ...VCF_FLEET_91, ...VCF_TAGS];

interface Build {
  readonly id: string;
  readonly label: string;
  readonly files: Readonly<Record<string, string>>;
}

function everyBuild(): Build[] {
  const out: Build[] = [];
  for (const blueprint of MINE) {
    const base = defaultValues(blueprint);
    const variants: { label: string; values: BlueprintValues }[] = [{ label: 'defaults', values: { ...base } }];
    for (const input of blueprint.inputs) {
      if (input.control === 'select') for (const option of input.options ?? []) variants.push({ label: `${input.id}=${option.value}`, values: { ...base, [input.id]: option.value } });
      if (input.control === 'toggle') variants.push({ label: `${input.id}=${String(!base[input.id])}`, values: { ...base, [input.id]: !base[input.id] } });
    }
    for (const variant of variants) out.push({ id: blueprint.id, label: variant.label, files: { ...blueprint.build(variant.values, blueprint.id).files } });
  }
  return out;
}

const BUILDS = everyBuild();
const where = (build: Build, file: string): string => `${build.id} (${build.label}) ${file}`;

/** A small RFC 4180 reader: enough to count columns in generated CSV. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function b32decode(text: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of text.replace(/0+$/, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe('automation/import: Logs, Networks and fleet blueprints emit what their targets import', () => {
  it('covers every blueprint in the five files', () => {
    expect(MINE.length).toBe(35);
  });

  it('every build has an IMPORT.md that names every file under import/', () => {
    for (const build of BUILDS) {
      const guide = build.files['IMPORT.md'];
      expect(typeof guide === 'string' && guide.startsWith('# Importing this into ')).toBe(true);
      for (const path of Object.keys(build.files).filter((p) => p.startsWith('import/'))) {
        const dir = path.slice(0, path.lastIndexOf('/'));
        const parent = dir.slice(0, dir.lastIndexOf('/'));
        const named = guide!.includes(path) || guide!.includes(`${dir}/`) || (parent.length > 'import'.length && guide!.includes(`${parent}/`));
        if (!named) throw new Error(`${where(build, path)} is not named in IMPORT.md`);
      }
    }
  });

  it('every .json and .vlcp parses', () => {
    for (const build of BUILDS) {
      for (const [path, text] of Object.entries(build.files)) {
        if (!/\.(json|vlcp)$/.test(path)) continue;
        try {
          JSON.parse(text);
        } catch (err) {
          throw new Error(`${where(build, path)}: ${(err as Error).message}`);
        }
      }
    }
  });

  it('the extracted-field internalName is encoded as the published packs encode it', () => {
    expect(vlcpInternalName('com.dell.networkingos10', 'dell_eventlog')).toBe('ibadem27mnxw2ltemvwgyltomv2ho33snnuw4z3pomytazdfnrwf6zlwmvxhi3dpm4000000');
    expect(vlcpInternalName('com.dell.networkingos10', 'dell_severity')).toBe('ibadem27mnxw2ltemvwgyltomv2ho33snnuw4z3pomytazdfnrwf643fozsxe2lupe000000');
  });

  it('every .vlcp has the content pack top level and element shapes', () => {
    let packs = 0;
    for (const build of BUILDS) {
      for (const [path, text] of Object.entries(build.files)) {
        if (!path.endsWith('.vlcp')) continue;
        packs += 1;
        expect(path.startsWith('import/')).toBe(true);
        const pack = JSON.parse(text) as Record<string, unknown>;
        for (const key of ['name', 'namespace', 'contentPackId', 'framework', 'version', 'extractedFields', 'queries', 'alerts', 'dashboardSections', 'author', 'contentVersion']) {
          if (!(key in pack)) throw new Error(`${where(build, path)} has no ${key}`);
        }
        expect(pack.framework).toBe('#9c4');
        expect(pack.version).toBe('2.4');
        expect(pack.contentPackId).toBe(pack.namespace);
        const ns = String(pack.namespace);
        for (const field of pack.extractedFields as Record<string, unknown>[]) {
          expect(Object.keys(field).sort().join(',')).toBe('constraints,displayName,info,internalName,postContext,preContext,regexValue');
          expect(b32decode(String(field.internalName))).toBe(`@@${ns.length}_${ns}${String(field.displayName)}`);
          JSON.parse(String(field.constraints));
        }
        for (const alert of pack.alerts as Record<string, unknown>[]) {
          expect(Object.keys(alert).join(',')).toBe('name,info,alertType,chartQuery,messageQuery,hitCount,hitOperator,searchPeriod,searchInterval');
          expect(Array.isArray((JSON.parse(String(alert.chartQuery)) as { fieldConstraints: unknown }).fieldConstraints)).toBe(true);
        }
        for (const query of pack.queries as Record<string, unknown>[]) {
          expect(Object.keys(query).join(',')).toBe('name,info,chartQuery,messageQuery');
          JSON.parse(String(query.chartQuery));
        }
        for (const section of pack.dashboardSections as { views: { name: string; rows: { widgets: Record<string, unknown>[] }[] }[] }[]) {
          for (const view of section.views) {
            expect(typeof view.name).toBe('string');
            for (const widget of view.rows.flatMap((row) => row.widgets)) {
              expect(Object.keys(widget).join(',')).toBe('name,info,chartType,chartOptions,widgetType,chartQuery,messageQuery');
              JSON.parse(String(widget.chartQuery));
            }
          }
        }
      }
    }
    expect(packs > 0).toBe(true);
  });

  it('the agent configuration is well-formed INI', () => {
    for (const build of BUILDS.filter((b) => b.id === 'vcflog_agent_group')) {
      const ini = build.files['import/liagent.ini'];
      expect(typeof ini).toBe('string');
      for (const line of ini!.split('\n')) {
        const t = line.trim();
        if (t === '' || t.startsWith(';') || t.startsWith('#')) continue;
        if (!/^\[[a-z]+(\|[A-Za-z0-9_-]+)?\]$/.test(t) && !/^[a-z_]+=/.test(t)) throw new Error(`${where(build, 'liagent.ini')}: "${t}"`);
      }
      expect(ini!.includes('[server]')).toBe(true);
    }
  });

  it('the forwarder body has the fields the Logs API takes, with the queue in bytes', () => {
    for (const build of BUILDS.filter((b) => b.id === 'vcflog_forwarding')) {
      const path = Object.keys(build.files).find((p) => p.startsWith('import/') && p.endsWith('.json'))!;
      const body = JSON.parse(build.files[path]!) as Record<string, unknown>;
      expect(Object.keys(body).sort().join(',')).toBe('acceptCert,diskCacheSize,filter,forwardComplementaryFields,host,name,port,protocol,sslEnabled,tags,transportProtocol,workerCount');
      expect(['syslog', 'cfapi', 'raw'].includes(String(body.protocol))).toBe(true);
      expect(['tcp', 'udp'].includes(String(body.transportProtocol))).toBe(true);
    }
  });

  it('every payload an apply.sh sends is in the build', () => {
    for (const build of BUILDS) {
      const script = build.files['apply.sh'] ?? build.files['vcfops-apply-groups.sh'];
      if (!script) continue;
      for (const match of script.matchAll(/^send \S+ '[^']*' '([^']+)'/gm)) {
        if (!(match[1]! in build.files)) throw new Error(`${where(build, 'apply.sh')} sends ${match[1]}, which is not generated`);
      }
    }
  });

  it('the tag standard is emitted as the PowerCLI CSV and the vCenter REST bodies', () => {
    for (const build of BUILDS.filter((b) => b.id === 'tags_taxonomy')) {
      const rows = csvRows(build.files['import/powercli/tag-standard.csv']!);
      expect(rows[0]!.join(',')).toBe('Category,Cardinality,EntityType,Tag,Description');
      expect(rows.length > 1).toBe(true);
      for (const row of rows.slice(1)) {
        expect(row.length).toBe(5);
        expect(['Single', 'Multiple'].includes(row[1]!)).toBe(true);
        expect(row[2]!.length > 0).toBe(true);
      }
      expect(build.files['import/powercli/Import-TagStandard.ps1']!.includes('New-TagCategory')).toBe(true);
      const categories = Object.entries(build.files).filter(([p]) => p.startsWith('import/vcenter-rest/categories/'));
      const tags = Object.entries(build.files).filter(([p]) => p.startsWith('import/vcenter-rest/tags/'));
      expect(categories.length > 0 && tags.length > 0).toBe(true);
      for (const [, text] of categories) {
        const body = JSON.parse(text) as Record<string, unknown>;
        expect(Object.keys(body).join(',')).toBe('name,description,cardinality,associable_types');
        expect(['SINGLE', 'MULTIPLE'].includes(String(body.cardinality))).toBe(true);
      }
      for (const [, text] of tags) expect(Object.keys(JSON.parse(text) as object).join(',')).toBe('name,description,category_id');
      // One CSV row per tag, as many tag bodies.
      expect(rows.slice(1).filter((row) => row[3] !== '').length).toBe(tags.length);
    }
  });

  it('the bulk assignment CSV is the one the scripts read', () => {
    for (const build of BUILDS.filter((b) => b.id === 'tags_bulk_assign')) {
      const rows = csvRows(build.files['assignments.csv']!);
      expect(rows[0]!.join(',')).toBe('vcenter,object_type,object,category,tag');
      for (const row of rows.slice(1)) expect(row.length).toBe(5);
      expect(build.files['IMPORT.md']!.includes('vcenter,object_type,object,category,tag')).toBe(true);
    }
  });

  it('the VCF Automation template from the tag consumers has name and version at the top', () => {
    for (const build of BUILDS.filter((b) => b.id === 'tags_consume')) {
      const path = Object.keys(build.files).find((p) => /^import\/templates\/[^/]+\/blueprint\.yaml$/.test(p));
      expect(path !== undefined).toBe(true);
      const text = build.files[path!]!;
      expect(/^name: /m.test(text) && /^version: /m.test(text) && /^formatVersion: 1$/m.test(text)).toBe(true);
    }
  });

  it('Networks: the discovery and bulk-device CSVs have their columns', () => {
    for (const build of BUILDS) {
      const discovery = build.files['import/application-discovery.csv'];
      if (discovery) {
        const rows = csvRows(discovery);
        expect(rows[0]!.join(',')).toBe('Application Name,Tier Name,VM Name');
        for (const row of rows.slice(1)) expect(row.length).toBe(3);
      }
      const devices = build.files['import/bulk-add-devices.csv'];
      if (devices) {
        const rows = csvRows(devices);
        expect(rows[0]!.join(',')).toBe('datasource_type,ip,fqdn,username,password,nickname,polling_interval_in_mins,collector_ip,notes');
        for (const row of rows.slice(1)) {
          expect(row.length).toBe(9);
          expect(row[4]).toBe('');
        }
      }
      if (build.id === 'vcfnet_applications') {
        expect(Object.keys(JSON.parse(build.files['import/application.json']!) as object).join(',')).toBe('name');
        for (const tier of JSON.parse(build.files['import/tiers.json']!) as Record<string, unknown>[]) expect(Object.keys(tier).join(',')).toBe('name,group_membership_criteria');
      }
    }
  });

  it('fleet request bodies carry no wrapper their endpoint does not take', () => {
    for (const build of BUILDS) {
      const role = build.files['role-assignment.json'];
      if (role) expect(Array.isArray((JSON.parse(role) as { vcfRoleAssignments?: unknown }).vcfRoleAssignments)).toBe(true);
      const dns = build.files['dns-setting.json'];
      if (dns) expect('ntpServers' in (JSON.parse(dns) as object)).toBe(false);
      const ntp = build.files['ntp-setting.json'];
      if (ntp) expect('dnsServers' in (JSON.parse(ntp) as object)).toBe(false);
      expect('fleet-setting.json' in build.files).toBe(false);
      const csr = build.files['csr-request.json'];
      if (csr) {
        const body = JSON.parse(csr) as { csrGenerationSpec: { keySize: unknown }; resources: unknown };
        expect(typeof body.csrGenerationSpec.keySize).toBe('string');
        expect(Array.isArray(body.resources)).toBe(true);
      }
      const install = build.files['install-certificates.json'];
      if (install) expect(Array.isArray(JSON.parse(install))).toBe(true);
      const plan = build.files['replace-plan.sh'];
      if (plan) expect(/install\) METHOD=PUT;/.test(plan)).toBe(true);
      const backup = build.files['fleet-backup-config.json'];
      if (backup) {
        const body = JSON.parse(backup) as Record<string, unknown>;
        expect(Object.keys(body).sort().join(',')).toBe('backupLocations,backupSchedules,encryption');
      }
    }
  });

  it('no generated file holds a credential literal', () => {
    const credential = /\b(password|passwd|secret|api[_-]?key|token|credential)\w*\s*[:=]+\s*["'][^"'$%{<@]/i;
    for (const build of BUILDS) {
      for (const [path, text] of Object.entries(build.files)) {
        if (credential.test(text)) throw new Error(`${where(build, path)} looks like it holds a credential`);
      }
    }
  });
});

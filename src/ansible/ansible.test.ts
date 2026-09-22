import { describe, it } from 'node:test';
import { expect } from '../testing/expect.ts';
import { hasErrors } from '../core/findings.ts';
import { COLLECTIONS, collectionFor, collectionOfModule, installable } from './collections.ts';
import { classifyModule, searchModules, catalogTotals, catalogued, notCatalogued, catalogFindings, catalogueFor } from './catalog.ts';
import { emitPlaybook, taskToYaml, requiredCollections, type Play } from './playbook.ts';
import { scaffoldAnsible } from './scaffold.ts';
import {
  emitInventoryCollection,
  emitClusterConfiguration,
  normaliseDrsBehavior,
  DRS_BEHAVIORS,
} from './vmware.ts';
import type { InventoryCluster } from '../vmware/inventory.ts';

describe('ansible/collections', () => {
  it('pins every collection whose version Galaxy gave us to that major line', () => {
    for (const collection of COLLECTIONS) {
      if (collection.builtin || collection.pinned === false) continue;
      const major = collection.observedVersion.split('.')[0];
      expect(collection.version).toContain(`>=${collection.observedVersion}`);
      expect(collection.version).toContain(`<${Number(major) + 1}.0.0`);
    }
  });

  it('says plainly when a version was never read, rather than inventing a pin', () => {
    for (const collection of COLLECTIONS) {
      if (collection.pinned !== false) continue;
      expect(collection.observedVersion.includes('not read from Galaxy')).toBe(true);
      expect(/^\d/.test(collection.version)).toBe(false);
    }
  });

  it('describes credentials for every collection rather than generating them', () => {
    for (const collection of COLLECTIONS) {
      expect(collection.credentials.length).toBeGreaterThan(10);
    }
  });

  it('keeps ansible.builtin out of requirements, since Galaxy does not publish it', () => {
    const names = installable(['ansible.builtin', 'amazon.aws']).map((c) => c.name);
    expect(names).toEqual(['amazon.aws']);
  });

  it('deduplicates a collection asked for twice', () => {
    expect(installable(['amazon.aws', 'amazon.aws'])).toHaveLength(1);
  });

  it('reads the collection out of a fully qualified module name', () => {
    expect(collectionOfModule('amazon.aws.ec2_instance')).toBe('amazon.aws');
    // Some modules carry a dot of their own; the collection is still the first two.
    expect(collectionOfModule('community.general.a.b')).toBe('community.general');
    expect(collectionOfModule('copy')).toBeUndefined();
    expect(collectionOfModule('ansible.builtin')).toBeUndefined();
  });

  it('records community.vmware as live rather than removed', () => {
    // It is still maintained, so describing it as deprecated would send people
    // away from modules that vmware.vmware has no replacement for.
    const legacy = collectionFor('community.vmware');
    expect(legacy).toBeDefined();
    expect(/deprecat/i.test(legacy?.note ?? '')).toBe(false);
  });
});

describe('ansible/catalog', () => {
  it('holds every collection whose version this build could read', () => {
    // The network vendor collections were added in a build with no Galaxy
    // access, so they are knowingly absent until `npm run ansible:update` runs
    // on a connected machine. Everything else must be there.
    const expected = COLLECTIONS.filter((c) => !c.builtin && c.pinned === false).map((c) => c.name);
    expect([...notCatalogued()].sort()).toEqual([...expected].sort());
    expect(catalogued().length).toBe(COLLECTIONS.filter((c) => !c.builtin && c.pinned !== false).length);
  });

  it('holds a real number of modules', () => {
    // A guard against a catalog that was regenerated into near-emptiness by a
    // partial fetch; the exact figure moves with every release.
    expect(catalogTotals().modules).toBeGreaterThan(3000);
  });

  it('recognises modules that exist', () => {
    expect(classifyModule('amazon.aws.ec2_instance')).toBe('module');
    expect(classifyModule('vmware.vmware.cluster_info')).toBe('module');
    expect(classifyModule('ansible.posix.mount')).toBe('module');
  });

  it('rejects a module that does not', () => {
    expect(classifyModule('amazon.aws.ec2_instance_that_is_not_real')).toBe('unknown');
  });

  it('separates not-knowing from knowing-it-is-wrong', () => {
    expect(classifyModule('nonexistent.collection.thing')).toBe('uncatalogued');
  });

  it('flags a short name as unqualified rather than unknown', () => {
    expect(classifyModule('copy')).toBe('not-qualified');
  });

  it('never reports ansible.builtin as missing, since it cannot be fetched', () => {
    expect(notCatalogued()).not.toContain('ansible.builtin');
    const incomplete = catalogFindings().find((f) => f.code === 'ansible.catalog.incomplete');
    expect(incomplete?.message.includes('ansible.builtin') ?? false).toBe(false);
  });

  it('does say which collections are missing, so the refresh has a reason', () => {
    const incomplete = catalogFindings().find((f) => f.code === 'ansible.catalog.incomplete');
    expect(incomplete?.message.includes('cisco.ios') ?? false).toBe(true);
    expect(incomplete?.remediation?.includes('ansible:update') ?? false).toBe(true);
  });

  it('searches on every term, across collections', () => {
    const hits = searchModules('vmware cluster', { limit: 200 });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.module.toLowerCase()).toContain('cluster');
      expect(hit.module.toLowerCase()).toContain('vmware');
    }
  });

  it('honours the search limit', () => {
    expect(searchModules('a', { limit: 5 })).toHaveLength(5);
  });

  it('returns nothing for an empty query rather than everything', () => {
    expect(searchModules('   ')).toEqual([]);
  });

  it('reports the catalog version alongside what the kit pins', () => {
    for (const name of catalogued()) {
      expect(catalogueFor(name)?.version).toBe(collectionFor(name)?.observedVersion);
    }
  });

  it('warns when the catalog has aged past the staleness threshold', () => {
    const future = new Date(Date.now() + 400 * 86_400_000);
    expect(catalogFindings(future).map((f) => f.code)).toContain('ansible.catalog.stale');
  });
});

describe('ansible/playbook', () => {
  const ping: Play = {
    name: 'Smoke test',
    hosts: 'localhost',
    gatherFacts: false,
    tasks: [{ name: 'Ping', module: 'ansible.builtin.ping' }],
  };

  it('puts the module key between the name and the task keywords', () => {
    const yaml = taskToYaml({
      name: 'Ping',
      module: 'ansible.builtin.ping',
      register: 'result',
      tags: ['smoke'],
    });
    expect(Object.keys(yaml)).toEqual(['name', 'ansible.builtin.ping', 'register', 'tags']);
  });

  it('writes an empty mapping for a module that takes no arguments', () => {
    expect(emitPlaybook([ping]).yaml).toContain('ansible.builtin.ping: {}');
  });

  it('emits a playbook a parser would accept as a list of plays', () => {
    const yaml = emitPlaybook([ping]).yaml;
    expect(yaml).toContain('---\n- name: Smoke test');
    expect(yaml).toContain('  hosts: localhost');
    expect(yaml).toContain('  gather_facts: false');
  });

  it('refuses a literal credential', () => {
    const out = emitPlaybook([
      {
        ...ping,
        tasks: [
          {
            name: 'Connect',
            module: 'vmware.vmware.cluster_info',
            arguments: { hostname: 'vc01', password: 'hunter2' },
            noLog: true,
          },
        ],
      },
    ]);
    expect(hasErrors(out.findings)).toBe(true);
    expect(out.findings.map((f) => f.code)).toContain('ansible.task.literal-credential');
  });

  it('accepts a credential that defers to a vault variable', () => {
    const out = emitPlaybook([
      {
        ...ping,
        tasks: [
          {
            name: 'Connect',
            module: 'vmware.vmware.cluster_info',
            arguments: { password: '{{ vault_vcenter_password }}' },
            noLog: true,
          },
        ],
      },
    ]);
    expect(out.findings.map((f) => f.code)).not.toContain('ansible.task.literal-credential');
  });

  it('warns when a task handles a secret without no_log', () => {
    const out = emitPlaybook([
      {
        ...ping,
        tasks: [
          {
            name: 'Connect',
            module: 'vmware.vmware.cluster_info',
            arguments: { password: '{{ vault_vcenter_password }}' },
          },
        ],
      },
    ]);
    expect(out.findings.map((f) => f.code)).toContain('ansible.task.secret-logged');
  });

  it('rejects a module the catalog does not have', () => {
    const out = emitPlaybook([
      { ...ping, tasks: [{ name: 'X', module: 'amazon.aws.not_a_module' }] },
    ]);
    expect(out.findings.map((f) => f.code)).toContain('ansible.task.unknown-module');
    expect(hasErrors(out.findings)).toBe(true);
  });

  it('warns rather than fails on a short module name', () => {
    const out = emitPlaybook([{ ...ping, tasks: [{ name: 'X', module: 'ping' }] }]);
    expect(out.findings.map((f) => f.code)).toContain('ansible.task.short-module-name');
    expect(hasErrors(out.findings)).toBe(false);
  });

  it('notes the wasted fact gather on a localhost play that did not say', () => {
    const out = emitPlaybook([
      { name: 'API work', hosts: 'localhost', tasks: [{ name: 'Ping', module: 'ansible.builtin.ping' }] },
    ]);
    expect(out.findings.map((f) => f.code)).toContain('ansible.play.gather-facts-default');
  });

  it('lists the collections a playbook needs, without the built-ins', () => {
    const collections = requiredCollections([
      {
        ...ping,
        tasks: [
          { name: 'a', module: 'ansible.builtin.ping' },
          { name: 'b', module: 'amazon.aws.ec2_instance' },
          { name: 'c', module: 'vmware.vmware.cluster_info' },
        ],
      },
    ]);
    expect(collections).toEqual(['amazon.aws', 'vmware.vmware']);
  });

  it('says plainly that it did not check the arguments', () => {
    expect(emitPlaybook([ping]).findings.map((f) => f.code)).toContain(
      'ansible.playbook.arguments-not-validated',
    );
  });
});

describe('ansible/scaffold', () => {
  it('generates the four files a repository needs', () => {
    const out = scaffoldAnsible({ targets: ['aws'] });
    expect(Object.keys(out.files).sort()).toEqual([
      '.gitignore',
      'ansible.cfg',
      'group_vars/all/vault.yml',
      'inventory/hosts.yml',
      'requirements.yml',
    ]);
  });

  it('pins collections in requirements.yml', () => {
    const out = scaffoldAnsible({ targets: ['aws'] });
    expect(out.files['requirements.yml']).toContain('name: amazon.aws');
    expect(out.files['requirements.yml']).toContain("version: '>=11.4.0,<12.0.0'");
  });

  it('never lists ansible.builtin in requirements.yml', () => {
    const out = scaffoldAnsible({ targets: ['general'] });
    expect(out.files['requirements.yml']).not.toContain('ansible.builtin');
  });

  it('leaves host key checking on', () => {
    // The single most copied Ansible setting, and the one that removes the only
    // check that the host answering is the host that was meant.
    expect(scaffoldAnsible({ targets: ['posix'] }).files['ansible.cfg']).toContain(
      'host_key_checking = True',
    );
  });

  it('leaves the legacy VMware collection out unless it is asked for', () => {
    const plain = scaffoldAnsible({ targets: ['vmware'] });
    expect(plain.files['requirements.yml']).not.toContain('community.vmware');
    const legacy = scaffoldAnsible({ targets: ['vmware'], includeLegacyVmware: true });
    expect(legacy.files['requirements.yml']).toContain('community.vmware');
    expect(legacy.findings.map((f) => f.code)).toContain(
      'ansible.scaffold.overlapping-vmware-collections',
    );
  });

  it('gitignores the vault file until it is encrypted', () => {
    const out = scaffoldAnsible({ targets: ['vmware'] });
    expect(out.files['.gitignore']).toContain('group_vars/all/vault.yml');
    expect(out.findings.map((f) => f.code)).toContain('ansible.scaffold.vault-not-encrypted');
  });

  it('writes no credential value into the vault template', () => {
    const vault = scaffoldAnsible({ targets: ['vmware', 'aws'] }).files['group_vars/all/vault.yml'] ?? '';
    // Every line is either a comment or the document marker.
    for (const line of vault.split('\n')) {
      if (line.trim() === '' || line.startsWith('#') || line === '---') continue;
      throw new Error(`Vault template carries a value: ${line}`);
    }
  });

  it('points localhost at the playbook interpreter for API-only work', () => {
    // Otherwise Ansible picks whatever python is on PATH, which need not be the
    // one the collections were installed into.
    expect(scaffoldAnsible({ targets: ['aws'] }).files['inventory/hosts.yml']).toContain(
      'ansible_python_interpreter:',
    );
  });

  it('names the Windows password rather than setting it', () => {
    const inv = scaffoldAnsible({ targets: ['windows'] }).files['inventory/hosts.yml'];
    expect(inv).toContain('ansible_password:');
    expect(inv).toContain('vault_windows_password');
  });

  it('reports the control-node packages a collection needs', () => {
    const codes = scaffoldAnsible({ targets: ['vmware'] }).findings.map((f) => f.code);
    expect(codes).toContain('ansible.scaffold.control-node-requirement');
  });

  it('says so rather than generating nothing in silence', () => {
    const out = scaffoldAnsible({ targets: [] });
    expect(out.files).toEqual({});
    expect(out.findings.map((f) => f.code)).toContain('ansible.scaffold.no-targets');
  });
});

describe('ansible/vmware', () => {
  const options = { datacenter: 'dc-01' };

  it('normalises an automation level from any of the three spellings in use', () => {
    expect(normaliseDrsBehavior('Fully Automated')).toBe('fullyAutomated');
    expect(normaliseDrsBehavior('FullyAutomated')).toBe('fullyAutomated');
    expect(normaliseDrsBehavior('fullyAutomated')).toBe('fullyAutomated');
    expect(normaliseDrsBehavior('partially_automated')).toBe('partiallyAutomated');
    expect(normaliseDrsBehavior('whatever')).toBeUndefined();
    expect(normaliseDrsBehavior(undefined)).toBeUndefined();
  });

  it('uses only module names the catalog holds', () => {
    const out = emitInventoryCollection(options);
    expect(out.findings.map((f) => f.code)).not.toContain('ansible.task.unknown-module');
    expect(hasErrors(out.findings)).toBe(false);
  });

  it('writes no credential into the collection playbook', () => {
    const out = emitInventoryCollection(options);
    expect(/password|username|VMWARE_PASSWORD\s*[:=]/.test(out.yaml.split('---')[1] ?? '')).toBe(false);
  });

  it('explains where the connection comes from, in the header', () => {
    expect(emitInventoryCollection(options).yaml).toContain('VMWARE_HOST');
  });

  it('needs only vmware.vmware, since the rest is built in', () => {
    expect(emitInventoryCollection(options).collections).toEqual(['vmware.vmware']);
  });

  it('writes one JSON file per gathered object type', () => {
    const yaml = emitInventoryCollection(options).yaml;
    for (const name of ['clusters', 'hosts', 'vms']) {
      expect(yaml).toContain(`/${name}.json`);
    }
  });

  it('renders cluster settings the inventory actually carries', () => {
    const clusters: InventoryCluster[] = [
      { name: 'mgmt-01', datacenter: 'dc-01', haEnabled: true, drsEnabled: true, drsAutomationLevel: 'Fully Automated' },
    ];
    const out = emitClusterConfiguration(clusters, options);
    expect(out.yaml).toContain('vmware.vmware.cluster:');
    expect(out.yaml).toContain('vmware.vmware.cluster_ha:');
    expect(out.yaml).toContain('drs_default_vm_behavior: fullyAutomated');
    expect(hasErrors(out.findings)).toBe(false);
  });

  it('writes nothing for a setting the inventory did not record', () => {
    // A gap in the data must not become a change to the estate.
    const out = emitClusterConfiguration([{ name: 'unknown-01', datacenter: 'dc-01' }], options);
    expect(out.yaml).not.toContain('cluster_ha');
    expect(out.yaml).not.toContain('cluster_drs');
    expect(out.findings.map((f) => f.code)).toContain('ansible.vmware.ha-unknown');
  });

  it('refuses an automation level the module would reject', () => {
    const out = emitClusterConfiguration(
      [{ name: 'c1', datacenter: 'dc-01', drsEnabled: true, drsAutomationLevel: 'semi-automatic' }],
      options,
    );
    expect(out.findings.map((f) => f.code)).toContain('ansible.vmware.unknown-drs-level');
    expect(out.yaml).not.toContain('semi-automatic');
    for (const behavior of DRS_BEHAVIORS) {
      expect(out.yaml).not.toContain(`drs_default_vm_behavior: ${behavior}`);
    }
  });

  it('says what it cannot express rather than inventing a module for it', () => {
    const out = emitClusterConfiguration(
      [{ name: 'c1', datacenter: 'dc-01', evcMode: 'intel-skylake', vsanEnabled: true }],
      options,
    );
    const codes = out.findings.map((f) => f.code);
    expect(codes).toContain('ansible.vmware.evc-not-emitted');
    expect(codes).toContain('ansible.vmware.vsan-not-emitted');
  });

  it('falls back to the chosen datacenter when a cluster does not name one', () => {
    const out = emitClusterConfiguration([{ name: 'c1', haEnabled: false }], options);
    expect(out.yaml).toContain('datacenter: dc-01');
  });

  it('reports an empty inventory rather than emitting an empty playbook', () => {
    const out = emitClusterConfiguration([], options);
    expect(out.yaml).toBe('');
    expect(out.findings.map((f) => f.code)).toContain('ansible.vmware.no-clusters');
  });
});

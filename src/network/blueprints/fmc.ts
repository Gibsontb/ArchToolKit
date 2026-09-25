/**
 * Cisco Secure Firewall Threat Defense, managed by the Firewall Management
 * Center.
 *
 * An FTD under FMC is never configured on the box: every change is made in FMC
 * and deployed to the firewall. So each change here is a list of FMC REST API
 * operations for cisco.fmcansible.fmc_configuration (see fmc-common.ts), and
 * the checks and back-outs are API calls and FMC GUI steps rather than
 * `show` commands. Objects, zones, access control and NAT are here; device
 * settings, routing, VPN, HA, registration and deployment are in
 * fmc-devices.ts.
 */

import { num, str, type BlueprintGroup, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, info, warning, type Finding } from '../../core/findings.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { description, listOf, type DeviceChange } from '../device.ts';
import { addressRef, apiChange, DELETE, fact, find, findAddress, findZone, IN_DOMAIN, objectKind, objectName, PLATFORM, PREVIEW_NOTE, ref, refOne, SRC, UPSERT, zoneRef, type Operation } from './fmc-common.ts';
import { FMC_DEVICES } from './fmc-devices.ts';

const OBJECTS: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'fmc_network_objects',
    platform: PLATFORM,
    label: 'Network objects and group',
    group: 'Objects',
    description: 'Host, network, range and FQDN objects (the type is read from the value), optionally gathered into a network group.',
    inputs: [
      { id: 'objects', label: 'Objects', control: 'textarea', default: 'WEB-01 10.10.10.11\nWEB-02 10.10.10.12\nAPP-NET 10.20.0.0/24\nDHCP-POOL 10.30.0.100-10.30.0.200\nUPDATES downloads.example.com', hint: 'One per line: NAME value' },
      { id: 'group', label: 'Group name', control: 'text', default: 'APP-SERVERS', hint: 'Empty for no group' },
      { id: 'object_description', label: 'Description', control: 'text', default: 'application tier' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const findings: Finding[] = [];
      const desc = description(str(values, 'object_description', ''), '');
      const objects = String(values['objects'] ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name = '', value = ''] = l.split(/\s+/);
          const kind = objectKind(value);
          if (!kind) findings.push(error('network.fmc.bad-object', `"${l}" is not NAME followed by an address, prefix, range or hostname.`, SRC));
          return { name: objectName(name, 'OBJECT'), value, kind };
        })
        .filter((o): o is { name: string; value: string; kind: 'Host' | 'Network' | 'Range' | 'FQDN' } => o.kind !== null);
      const names = objects.map((o) => o.name);
      if (new Set(names).size !== names.length) findings.push(warning('network.fmc.duplicate-object', 'Two objects share a name: the second upsert overwrites the first.', SRC));
      if (objects.length === 0) findings.push(error('network.fmc.no-objects', 'No objects could be read.', SRC));
      const group = objectName(str(values, 'group', ''), '');
      const ops: Operation[] = objects.map((o) => ({
        operation: UPSERT[o.kind],
        data: { name: o.name, value: o.value, type: o.kind, ...(desc ? { description: desc } : {}), ...(o.kind === 'FQDN' ? { dnsResolution: 'IPV4_AND_IPV6' } : {}) },
        path_params: IN_DOMAIN,
        register_as: fact('obj', o.name),
      }));
      if (group) {
        ops.push({ operation: 'upsertNetworkGroup', data: { name: group, type: 'NetworkGroup', objects: objects.map((o) => refOne(fact('obj', o.name), o.kind)) }, path_params: IN_DOMAIN, register_as: fact('grp', group) });
      }
      return apiChange(ops, {
        title: `${objects.length} network object(s)${group ? ` in group ${group}` : ''}`,
        impact: 'none',
        notes: [
          'Upsert creates the object or updates the one with the same name, so running it twice is safe. Updating an object a rule already uses changes that rule at the next deployment.',
          ...(objects.some((o) => o.kind === 'FQDN') ? ['An FQDN object only resolves once the device has a DNS server group in its platform settings, and can be used in access rules but not in NAT.'] : []),
        ],
        before: [...objects.map((o) => `GET /api/fmc_config/v1/domain/{domainUUID}/object/networkaddresses?filter=nameOrValue:${o.name}`), 'FMC: Objects > Object Management > Network (search each name)'],
        verify: [...objects.map((o) => `FMC: Objects > Object Management > Network shows ${o.name} = ${o.value}`), ...(group ? [`GET /api/fmc_config/v1/domain/{domainUUID}/object/networkgroups?filter=nameOrValue:${group}`] : [])],
        backout: [
          ...(group ? [`deleteNetworkGroup (objectId of ${group})`] : []),
          ...objects.map((o) => `${DELETE[o.kind]} (objectId of ${o.name})`),
          'Or FMC: Objects > Object Management > Network > delete each. FMC refuses to delete an object a rule, NAT or route still uses: remove the reference first.',
        ],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_port_objects',
    platform: PLATFORM,
    label: 'Port objects and group',
    group: 'Objects',
    description: 'TCP and UDP port objects, single ports or ranges, optionally gathered into a port object group.',
    inputs: [
      { id: 'ports', label: 'Ports', control: 'textarea', default: 'HTTPS-8443 tcp 8443\nAPP-RPC tcp 9000-9010\nSYSLOG-UDP udp 514', hint: 'One per line: NAME tcp|udp port-or-range' },
      { id: 'group', label: 'Group name', control: 'text', default: 'APP-PORTS', hint: 'Empty for no group' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const findings: Finding[] = [];
      const ports = String(values['ports'] ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .flatMap((l) => {
          const [name = '', protocol = '', port = ''] = l.split(/\s+/);
          const p = protocol.toUpperCase();
          const range = /^(\d+)(-(\d+))?$/.exec(port);
          const ok = (p === 'TCP' || p === 'UDP') && range && Number(range[1]) >= 1 && Number(range[3] ?? range[1]) <= 65535 && Number(range[3] ?? range[1]) >= Number(range[1]);
          if (!ok) {
            findings.push(error('network.fmc.bad-port', `"${l}" is not NAME tcp|udp port (1-65535, or a range low-high).`, SRC));
            return [];
          }
          return [{ name: objectName(name, 'PORT'), protocol: p, port }];
        });
      if (ports.length === 0) findings.push(error('network.fmc.no-ports', 'No port objects could be read.', SRC));
      const group = objectName(str(values, 'group', ''), '');
      const ops: Operation[] = ports.map((p) => ({
        operation: 'upsertProtocolPortObject',
        data: { name: p.name, protocol: p.protocol, port: p.port, type: 'ProtocolPortObject' },
        path_params: IN_DOMAIN,
        register_as: fact('port', p.name),
      }));
      if (group) ops.push({ operation: 'upsertPortObjectGroup', data: { name: group, type: 'PortObjectGroup', objects: ports.map((p) => refOne(fact('port', p.name), 'ProtocolPortObject')) }, path_params: IN_DOMAIN, register_as: fact('pgrp', group) });
      return apiChange(ops, {
        title: `${ports.length} port object(s)${group ? ` in group ${group}` : ''}`,
        impact: 'none',
        before: [...ports.map((p) => `GET /api/fmc_config/v1/domain/{domainUUID}/object/protocolportobjects?filter=nameOrValue:${p.name}`), 'FMC: Objects > Object Management > Port'],
        verify: [...ports.map((p) => `FMC: Objects > Object Management > Port shows ${p.name} = ${p.protocol}/${p.port}`)],
        backout: [...(group ? [`deletePortObjectGroup (objectId of ${group})`] : []), ...ports.map((p) => `deleteProtocolPortObject (objectId of ${p.name})`), 'FMC refuses to delete a port object a rule still uses.'],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_security_zone',
    platform: PLATFORM,
    label: 'Security zones',
    group: 'Objects',
    description: 'Security zones for routed (or switched, inline, passive) interfaces, ready for the interfaces and rules to use.',
    inputs: [
      { id: 'zones', label: 'Zone names', control: 'text', default: 'INSIDE, OUTSIDE, DMZ' },
      {
        id: 'mode',
        label: 'Interface mode',
        control: 'select',
        default: 'ROUTED',
        options: [
          { value: 'ROUTED', label: 'Routed' },
          { value: 'SWITCHED', label: 'Switched' },
          { value: 'INLINE', label: 'Inline' },
          { value: 'PASSIVE', label: 'Passive' },
          { value: 'ASA', label: 'ASA (FirePOWER module)' },
        ],
      },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const zones = listOf(str(values, 'zones', '')).map((z) => objectName(z, 'ZONE'));
      const mode = str(values, 'mode', 'ROUTED');
      const findings: Finding[] = zones.length === 0 ? [error('network.fmc.no-zones', 'No zone names given.', SRC)] : [];
      const ops: Operation[] = zones.map((z) => ({ operation: 'upsertSecurityZoneObject', data: { name: z, type: 'SecurityZone', interfaceMode: mode }, path_params: IN_DOMAIN, register_as: fact('newzone', z) }));
      return apiChange(ops, {
        title: `Security zones ${zones.join(', ')}`,
        impact: 'none',
        notes: ['A zone’s interface mode cannot be changed once interfaces are in it. Put interfaces in it with the interface blueprint.'],
        before: ['GET /api/fmc_config/v1/domain/{domainUUID}/object/securityzones', 'FMC: Objects > Object Management > Interface'],
        verify: zones.map((z) => `FMC: Objects > Object Management > Interface shows ${z} (${mode})`),
        backout: [...zones.map((z) => `deleteSecurityZoneObject (objectId of ${z})`), 'A zone in use by an interface or rule cannot be deleted: remove it there first.'],
        findings,
      });
    },
  }),
];

const ACCESS: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'fmc_access_policy',
    platform: PLATFORM,
    label: 'Access control policy',
    group: 'Access control',
    description: 'An access control policy with its default action and logging, optionally assigned to a device.',
    inputs: [
      { id: 'name', label: 'Policy name', control: 'text', default: 'EDGE-ACP' },
      {
        id: 'default_action',
        label: 'Default action',
        control: 'select',
        default: 'BLOCK',
        options: [
          { value: 'BLOCK', label: 'Block all traffic' },
          { value: 'PERMIT', label: 'Intrusion prevention (permit and inspect)' },
          { value: 'NETWORK_DISCOVERY', label: 'Network discovery only' },
          { value: 'TRUST', label: 'Trust all traffic' },
        ],
      },
      { id: 'intrusion_policy', label: 'Default intrusion policy', control: 'text', default: 'Balanced Security and Connectivity', showWhen: { input: 'default_action', equals: ['PERMIT'] } },
      { id: 'device', label: 'Assign to device', control: 'text', default: '', hint: 'The device name in FMC; empty to leave assignments alone' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const name = objectName(str(values, 'name', ''), 'ACP');
      const action = str(values, 'default_action', 'BLOCK');
      const ips = str(values, 'intrusion_policy', 'Balanced Security and Connectivity');
      const device = str(values, 'device', '');
      const acp = fact('acp', name);
      const findings: Finding[] = [];
      if (action === 'TRUST') findings.push(warning('network.fmc.default-trust', 'The default action trusts everything no rule matches: it passes uninspected and unlogged. Block, or inspect, by default.', SRC));
      const ops: Operation[] = [
        ...(action === 'PERMIT' ? [find('getAllIntrusionPolicy', ips, fact('ips', ips))] : []),
        {
          operation: 'upsertAccessPolicy',
          data: {
            name,
            type: 'AccessPolicy',
            defaultAction: { action, logBegin: false, logEnd: action !== 'BLOCK', sendEventsToFMC: true, ...(action === 'PERMIT' ? { intrusionPolicy: ref(fact('ips', ips), 'IntrusionPolicy') } : {}) },
          },
          path_params: IN_DOMAIN,
          register_as: acp,
        },
        ...(device
          ? [
              find('getAllDevice', device, fact('dev', device)),
              { operation: 'createPolicyAssignment', data: { type: 'PolicyAssignment', policy: refOne(acp, 'AccessPolicy'), targets: [ref(fact('dev', device), 'Device')] }, path_params: IN_DOMAIN },
            ]
          : []),
      ];
      return apiChange(ops, {
        title: `Access control policy ${name} (default ${action})`,
        impact: device ? 'outage' : 'none',
        notes: [
          ...(device ? [`Assigning it replaces the policy ${device} runs now: at deployment, only this policy’s rules apply. With default BLOCK and no rules yet, that is everything blocked.`] : ['Nothing uses the policy until it is assigned to a device and deployed.']),
          PREVIEW_NOTE,
        ],
        before: ['GET /api/fmc_config/v1/domain/{domainUUID}/policy/accesspolicies', ...(device ? [`FMC: Devices > Device Management > ${device}: note the access policy assigned now`] : [])],
        verify: [`FMC: Policies > Access Control shows ${name}, default action ${action}`, ...(device ? [`GET /api/fmc_config/v1/domain/{domainUUID}/assignment/policyassignments (targets include ${device})`] : [])],
        backout: [...(device ? [`Re-assign the previous policy to ${device} (Policies > Access Control > Policy Assignments) and deploy`] : []), `deleteAccessPolicy (objectId of ${name}) once nothing is assigned to it`],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_access_rule',
    platform: PLATFORM,
    label: 'Access rule',
    group: 'Access control',
    description: 'An access rule between zones, networks and ports, with an intrusion and file policy for allowed traffic, and logging at connection end.',
    inputs: [
      { id: 'policy', label: 'Access policy', control: 'text', default: 'EDGE-ACP' },
      { id: 'name', label: 'Rule name', control: 'text', default: 'WEB-IN' },
      {
        id: 'action',
        label: 'Action',
        control: 'select',
        default: 'ALLOW',
        options: [
          { value: 'ALLOW', label: 'Allow (inspect)' },
          { value: 'TRUST', label: 'Trust (no inspection)' },
          { value: 'BLOCK', label: 'Block' },
          { value: 'BLOCK_RESET', label: 'Block with reset' },
          { value: 'MONITOR', label: 'Monitor' },
        ],
      },
      { id: 'source_zone', label: 'Source zone', control: 'text', default: 'OUTSIDE' },
      { id: 'destination_zone', label: 'Destination zone', control: 'text', default: 'DMZ' },
      { id: 'source_networks', label: 'Source networks', control: 'text', default: '', hint: 'Object names; empty for any' },
      { id: 'destination_networks', label: 'Destination networks', control: 'text', default: 'APP-SERVERS' },
      { id: 'destination_ports', label: 'Destination ports', control: 'text', default: 'HTTPS', hint: 'Port object names; empty for any' },
      { id: 'intrusion_policy', label: 'Intrusion policy', control: 'text', default: 'Balanced Security and Connectivity', hint: 'Empty for none' },
      { id: 'file_policy', label: 'File policy', control: 'text', default: '', hint: 'e.g. Block Malware; empty for none' },
      { id: 'variable_set', label: 'Variable set', control: 'text', default: 'Default-Set' },
      { id: 'logging', label: 'Logging', control: 'select', default: 'end', options: [{ value: 'end', label: 'At end of connection' }, { value: 'both', label: 'At beginning and end' }, { value: 'none', label: 'No logging' }] },
      { id: 'section', label: 'Section', control: 'select', default: 'mandatory', options: [{ value: 'mandatory', label: 'Mandatory' }, { value: 'default', label: 'Default' }] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const policy = str(values, 'policy', 'EDGE-ACP');
      const name = str(values, 'name', 'RULE').slice(0, 30);
      const action = str(values, 'action', 'ALLOW');
      const srcZone = str(values, 'source_zone', '');
      const dstZone = str(values, 'destination_zone', '');
      const srcNets = listOf(str(values, 'source_networks', ''));
      const dstNets = listOf(str(values, 'destination_networks', ''));
      const ports = listOf(str(values, 'destination_ports', ''));
      const ips = str(values, 'intrusion_policy', '');
      const file = str(values, 'file_policy', '');
      const varset = str(values, 'variable_set', 'Default-Set');
      const logging = str(values, 'logging', 'end');
      const section = str(values, 'section', 'mandatory');
      const allows = action === 'ALLOW' || action === 'TRUST';
      const inspect = action === 'ALLOW';
      const blocks = action === 'BLOCK' || action === 'BLOCK_RESET';
      const acp = fact('acp', policy);
      const findings: Finding[] = [];
      if (allows && srcNets.length === 0 && dstNets.length === 0 && ports.length === 0) {
        findings.push(warning('network.fmc.any-any-allow', `The rule ${action === 'TRUST' ? 'trusts' : 'allows'} any source to any destination on any port${srcZone || dstZone ? ' between the zones' : ''}.`, { remediation: 'Name the destination networks and ports the rule is for.', ...SRC }));
      }
      if (logging === 'none') findings.push(warning('network.fmc.no-logging', 'Logging is off: connections this rule matches leave no event in FMC.', { remediation: 'Log at the end of the connection.', ...SRC }));
      if (inspect && !ips) findings.push(info('network.fmc.no-intrusion', 'Allowed traffic is not inspected by an intrusion policy.', SRC));
      if (action === 'TRUST') findings.push(info('network.fmc.trust-no-inspection', 'Trust skips every inspection, including intrusion and file policies. Use Allow unless the flow is known and high-volume.', SRC));
      const ops: Operation[] = [
        find('getAllAccessPolicy', policy, acp),
        ...(srcZone ? [findZone(srcZone)] : []),
        ...(dstZone ? [findZone(dstZone)] : []),
        ...[...srcNets, ...dstNets].map(findAddress),
        ...ports.map((p) => find('getAllProtocolPortObject', p, fact('port', p))),
        ...(inspect && ips ? [find('getAllIntrusionPolicy', ips, fact('ips', ips)), find('getAllVariableSet', varset, fact('vars', varset))] : []),
        ...(inspect && file ? [find('getAllFilePolicy', file, fact('file', file))] : []),
        {
          operation: 'createMultipleAccessRule',
          data: {
            name,
            type: 'AccessRule',
            action,
            enabled: true,
            ...(srcZone ? { sourceZones: { objects: [zoneRef(srcZone)] } } : {}),
            ...(dstZone ? { destinationZones: { objects: [zoneRef(dstZone)] } } : {}),
            ...(srcNets.length ? { sourceNetworks: { objects: srcNets.map(addressRef) } } : {}),
            ...(dstNets.length ? { destinationNetworks: { objects: dstNets.map(addressRef) } } : {}),
            ...(ports.length ? { destinationPorts: { objects: ports.map((p) => ref(fact('port', p), 'ProtocolPortObject')) } } : {}),
            ...(inspect && ips ? { ipsPolicy: ref(fact('ips', ips), 'IntrusionPolicy'), variableSet: ref(fact('vars', varset), 'VariableSet') } : {}),
            ...(inspect && file ? { filePolicy: ref(fact('file', file), 'FilePolicy') } : {}),
            // A blocked connection has no end, so it is logged at its beginning.
            logBegin: logging === 'both' || (blocks && logging !== 'none'),
            logEnd: logging !== 'none' && !blocks,
            logFiles: inspect && file !== '',
            sendEventsToFMC: logging !== 'none',
            newComments: ['Created by ArchToolKit change'],
          },
          query_params: { section },
          path_params: { containerUUID: `{{ ${acp}[0].id }}`, domainUUID: '{{ domain[0].uuid }}' },
          register_as: fact('rule', name),
        },
      ];
      return apiChange(ops, {
        title: `Access rule ${name} (${action}) in ${policy}`,
        impact: 'brief',
        notes: [
          `The rule is added at the end of the ${section} section; rules match top-down, so an earlier rule that matches the same traffic wins. Move it in the policy if it has to sit higher.`,
          'The rule name must be unique in the policy: running this twice fails on the second run rather than adding a duplicate.',
          ...(inspect && (ips || file) ? ['Adding an intrusion or file policy can restart the Snort process at deployment, which briefly drops or passes traffic depending on the device’s settings.'] : []),
          'Objects, zones and policies are looked up by name and must already exist.',
          PREVIEW_NOTE,
        ],
        before: [`GET /api/fmc_config/v1/domain/{domainUUID}/policy/accesspolicies/{policyId}/accessrules?expanded=true (policy ${policy})`, `FMC: Policies > Access Control > ${policy}: note the rules above and below the insertion point`],
        verify: [`FMC: Policies > Access Control > ${policy} shows ${name} in the ${section} section`, `After deployment, on the FTD: show access-control-config | begin ${name}`, 'FMC: Analysis > Connections > Events, filtered on the rule name'],
        backout: [`deleteAccessRule (containerUUID = ${policy}'s id, objectId = ${name}'s id), or delete the rule in Policies > Access Control > ${policy}`, 'Then deploy.'],
        findings,
      });
    },
  }),
];

/** The NAT policy, created if missing, and optionally assigned. */
function natPolicy(name: string): Operation {
  return { operation: 'upsertFTDNatPolicy', data: { name, type: 'FTDNatPolicy' }, path_params: IN_DOMAIN, register_as: fact('nat', name) };
}

const NAT: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'fmc_manual_nat',
    platform: PLATFORM,
    label: 'Manual (twice) NAT rule',
    group: 'NAT',
    description: 'A manual NAT rule: source translation to an object or the interface, optionally with a destination translation, before or after auto NAT.',
    inputs: [
      { id: 'policy', label: 'NAT policy', control: 'text', default: 'EDGE-NAT' },
      { id: 'nat_type', label: 'Type', control: 'select', default: 'DYNAMIC', options: [{ value: 'DYNAMIC', label: 'Dynamic (hide)' }, { value: 'STATIC', label: 'Static' }] },
      { id: 'source_zone', label: 'Source zone', control: 'text', default: 'INSIDE' },
      { id: 'destination_zone', label: 'Destination zone', control: 'text', default: 'OUTSIDE' },
      { id: 'original_source', label: 'Original source', control: 'text', default: 'APP-NET' },
      { id: 'translated_source', label: 'Translated source', control: 'text', default: 'interface', hint: 'An object name, or interface for the egress interface address' },
      { id: 'original_destination', label: 'Original destination', control: 'text', default: '', hint: 'Optional: an object name' },
      { id: 'translated_destination', label: 'Translated destination', control: 'text', default: '', hint: 'Optional: an object name' },
      { id: 'section', label: 'Section', control: 'select', default: 'before_auto', options: [{ value: 'before_auto', label: 'Before auto NAT' }, { value: 'after_auto', label: 'After auto NAT' }] },
      { id: 'rule_description', label: 'Description', control: 'text', default: 'app tier to internet' },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const policy = objectName(str(values, 'policy', ''), 'NAT');
      const natType = str(values, 'nat_type', 'DYNAMIC');
      const srcZone = str(values, 'source_zone', '');
      const dstZone = str(values, 'destination_zone', '');
      const origSrc = str(values, 'original_source', '');
      const transSrc = str(values, 'translated_source', 'interface');
      const origDst = str(values, 'original_destination', '');
      const transDst = str(values, 'translated_destination', '');
      const viaInterface = transSrc.toLowerCase() === 'interface';
      const findings: Finding[] = [];
      if (!origSrc) findings.push(error('network.fmc.nat-no-source', 'A manual NAT rule needs an original source.', SRC));
      if (viaInterface && !dstZone) findings.push(error('network.fmc.nat-interface-zone', 'Interface PAT needs a destination zone with one interface in it.', SRC));
      if ((origDst && !transDst) || (!origDst && transDst)) findings.push(warning('network.fmc.nat-half-destination', 'Give both the original and the translated destination, or neither.', SRC));
      if (natType === 'DYNAMIC' && section(values) === 'after_auto') findings.push(info('network.fmc.nat-after-auto', 'After auto NAT, a matching auto NAT (object) rule is used first.', SRC));
      const nat = fact('nat', policy);
      const ops: Operation[] = [
        natPolicy(policy),
        ...(srcZone ? [findZone(srcZone)] : []),
        ...(dstZone ? [findZone(dstZone)] : []),
        ...[origSrc, ...(viaInterface ? [] : [transSrc]), origDst, transDst].filter(Boolean).map(findAddress),
        {
          operation: 'createMultipleFTDManualNatRule',
          data: {
            type: 'FTDManualNatRule',
            natType,
            enabled: true,
            ...(str(values, 'rule_description', '') ? { description: description(str(values, 'rule_description', ''), '') } : {}),
            ...(srcZone ? { sourceInterface: zoneRef(srcZone) } : {}),
            ...(dstZone ? { destinationInterface: zoneRef(dstZone) } : {}),
            originalSource: addressRef(origSrc),
            ...(viaInterface ? { interfaceInTranslatedSource: true } : { translatedSource: addressRef(transSrc) }),
            ...(origDst && transDst ? { originalDestination: addressRef(origDst), translatedDestination: addressRef(transDst) } : {}),
            dns: false,
            routeLookup: false,
            noProxyArp: false,
            unidirectional: false,
          },
          query_params: { section: section(values) },
          path_params: { containerUUID: `{{ ${nat}.id }}`, domainUUID: '{{ domain[0].uuid }}' },
        },
      ];
      return apiChange(ops, {
        title: `Manual NAT ${origSrc} -> ${viaInterface ? 'interface' : transSrc} in ${policy}`,
        impact: 'brief',
        notes: [
          `The NAT policy ${policy} is created if missing; it still has to be assigned to the device (Devices > NAT > Policy Assignments) before it deploys.`,
          'NAT does not permit traffic: an access rule has to allow it, written against the real (untranslated) addresses.',
          PREVIEW_NOTE,
        ],
        before: [`GET /api/fmc_config/v1/domain/{domainUUID}/policy/ftdnatpolicies/{natId}/manualnatrules?expanded=true (policy ${policy})`, 'On the FTD: show nat detail'],
        verify: [`FMC: Devices > NAT > ${policy} shows the rule in the ${section(values).replace('_', ' ')} section`, 'After deployment, on the FTD: show nat detail, and show xlate'],
        backout: [`deleteFTDManualNatRule (containerUUID = ${policy}'s id, objectId = the rule's id), or delete it in Devices > NAT > ${policy}`, 'Then deploy. Existing translations age out; clear xlate on the FTD to drop them at once.'],
        findings,
      });
    },
  }),

  deviceBlueprint({
    id: 'fmc_auto_nat',
    platform: PLATFORM,
    label: 'Auto (object) NAT rule',
    group: 'NAT',
    description: 'An auto NAT rule on a network object: dynamic PAT to the interface or a pool, or a static one-to-one translation with an optional port.',
    inputs: [
      { id: 'policy', label: 'NAT policy', control: 'text', default: 'EDGE-NAT' },
      { id: 'nat_type', label: 'Type', control: 'select', default: 'STATIC', options: [{ value: 'STATIC', label: 'Static' }, { value: 'DYNAMIC', label: 'Dynamic' }] },
      { id: 'source_zone', label: 'Real (source) zone', control: 'text', default: 'DMZ' },
      { id: 'destination_zone', label: 'Mapped (destination) zone', control: 'text', default: 'OUTSIDE' },
      { id: 'original_network', label: 'Real object', control: 'text', default: 'WEB-01' },
      { id: 'translated_network', label: 'Mapped object', control: 'text', default: 'WEB-01-PUBLIC', hint: 'An object name, or interface' },
      { id: 'protocol', label: 'Port translation', control: 'select', default: 'none', options: [{ value: 'none', label: 'None' }, { value: 'TCP', label: 'TCP' }, { value: 'UDP', label: 'UDP' }], showWhen: { input: 'nat_type', equals: ['STATIC'] } },
      { id: 'original_port', label: 'Real port', control: 'number', default: 8443, min: 1, max: 65535, showWhen: { input: 'protocol', notEquals: ['none'] } },
      { id: 'translated_port', label: 'Mapped port', control: 'number', default: 443, min: 1, max: 65535, showWhen: { input: 'protocol', notEquals: ['none'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const policy = objectName(str(values, 'policy', ''), 'NAT');
      const natType = str(values, 'nat_type', 'STATIC');
      const srcZone = str(values, 'source_zone', '');
      const dstZone = str(values, 'destination_zone', '');
      const orig = str(values, 'original_network', '');
      const trans = str(values, 'translated_network', 'interface');
      const viaInterface = trans.toLowerCase() === 'interface';
      const protocol = natType === 'STATIC' ? str(values, 'protocol', 'none') : 'none';
      const findings: Finding[] = [];
      if (!orig) findings.push(error('network.fmc.nat-no-source', 'An auto NAT rule needs the real object.', SRC));
      if (natType === 'STATIC' && protocol === 'none' && !viaInterface) findings.push(info('network.fmc.static-nat-exposed', 'A static one-to-one translation makes the host reachable on every port the access policy allows: keep the access rule narrow.', SRC));
      const nat = fact('nat', policy);
      const ops: Operation[] = [
        natPolicy(policy),
        ...(srcZone ? [findZone(srcZone)] : []),
        ...(dstZone ? [findZone(dstZone)] : []),
        ...[orig, ...(viaInterface ? [] : [trans])].filter(Boolean).map(findAddress),
        {
          operation: 'createMultipleFTDAutoNatRule',
          data: {
            type: 'FTDAutoNatRule',
            natType,
            ...(srcZone ? { sourceInterface: zoneRef(srcZone) } : {}),
            ...(dstZone ? { destinationInterface: zoneRef(dstZone) } : {}),
            originalNetwork: addressRef(orig),
            ...(viaInterface ? { interfaceInTranslatedNetwork: true } : { translatedNetwork: addressRef(trans) }),
            ...(protocol !== 'none' ? { serviceProtocol: protocol, originalPort: num(values, 'original_port', 8443), translatedPort: num(values, 'translated_port', 443) } : {}),
            dns: false,
            routeLookup: false,
            noProxyArp: false,
            netToNet: false,
            fallThrough: false,
            interfaceIpv6: false,
          },
          path_params: { containerUUID: `{{ ${nat}.id }}`, domainUUID: '{{ domain[0].uuid }}' },
        },
      ];
      return apiChange(ops, {
        title: `Auto NAT ${orig} -> ${viaInterface ? 'interface' : trans}${protocol !== 'none' ? ` ${protocol}` : ''} in ${policy}`,
        impact: 'brief',
        notes: [
          'An object carries one auto NAT rule: FMC refuses a second on the same object and direction.',
          'Inbound, the access rule is written to the real address (the object), not the mapped one.',
          `The NAT policy ${policy} has to be assigned to the device before it deploys.`,
          PREVIEW_NOTE,
        ],
        before: [`GET /api/fmc_config/v1/domain/{domainUUID}/policy/ftdnatpolicies/{natId}/autonatrules?expanded=true (policy ${policy})`, 'On the FTD: show nat detail'],
        verify: [`FMC: Devices > NAT > ${policy} shows the rule under Auto NAT`, 'After deployment, on the FTD: show nat detail, show xlate', 'packet-tracer on the FTD, or Devices > Troubleshoot > Packet Tracer'],
        backout: [`deleteFTDAutoNatRule (containerUUID = ${policy}'s id, objectId = the rule's id), or delete it in Devices > NAT > ${policy}`, 'Then deploy.'],
        findings,
      });
    },
  }),
];

function section(values: BlueprintValues): string {
  return str(values, 'section', 'before_auto');
}

const ALL: readonly ChangeBlueprint[] = [...OBJECTS, ...ACCESS, ...NAT, ...FMC_DEVICES];

export const FMC_NETWORK: BlueprintGroup = {
  target: PLATFORM,
  label: 'Cisco Secure Firewall (FTD via FMC)',
  blueprints: ALL,
};

export const FMC_CHANGES: readonly ChangeBlueprint[] = ALL;


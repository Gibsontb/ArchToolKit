/**
 * Cisco Catalyst 9800: rogue policy, mDNS gateway and application visibility.
 *
 * wlc.ts builds what makes an SSID work — WLANs, policy and join profiles,
 * tags, RF, RADIUS, FlexConnect, mobility. What was missing is what an
 * operator adds once it works: deciding which neighbouring access points are
 * a threat (and, with care, containing them), letting AirPlay, Chromecast and
 * printers be found across VLANs without flooding multicast, and seeing — and
 * shaping — which applications are on the air.
 *
 * Every change here touches a policy profile, a WLAN or the AP join profile,
 * and the 9800 applies most of those only while the profile is shut. The
 * impact levels say so.
 *
 * Where a sub-command's exact form varies between 17.x releases, the note says
 * VERIFY: check it with `?` on the controller before a change window.
 */

import { bool, num, str, type BlueprintValues } from '../../kit/blueprint.ts';
import { error, warning, type Finding } from '../../core/findings.ts';
import { isIp, familyOf } from '../../core/ip.ts';
import { deviceBlueprint, type ChangeBlueprint } from '../from-change.ts';
import { listOf, type DeviceChange } from '../device.ts';

const PLATFORM = 'cisco_wlc' as const;

const upper = (value: string, fallback: string): string => (value.trim() || fallback).toUpperCase().replace(/\s+/g, '-');

/** The mDNS service definitions the 9800 ships with, for the checklist. */
const MDNS_SERVICES: readonly { value: string; label: string }[] = [
  { value: 'airplay', label: 'AirPlay' },
  { value: 'airtunes', label: 'AirTunes' },
  { value: 'google-chromecast', label: 'Chromecast' },
  { value: 'printer-ipp', label: 'Printer (IPP)' },
  { value: 'printer-ipps', label: 'Printer (IPPS)' },
  { value: 'printer-socket', label: 'Printer (socket)' },
  { value: 'scanner', label: 'Scanner' },
  { value: 'homesharing', label: 'iTunes home sharing' },
  { value: 'apple-file-share', label: 'Apple file sharing' },
  { value: 'apple-screen-share', label: 'Apple screen sharing' },
];

export const WLC_EXTRA: readonly ChangeBlueprint[] = [
  deviceBlueprint({
    id: 'wlc_rogue_policy',
    platform: PLATFORM,
    label: 'Rogue detection and classification',
    group: 'Security',
    description: 'How the controller decides which access points it hears are a threat: the RSSI below which they are ignored, rules that mark a neighbour broadcasting your SSID or plugged into your wire as malicious, and — only with sign-off — automatic containment.',
    inputs: [
      { id: 'security_level', label: 'Rogue security level', control: 'select', default: 'custom', options: [
        { value: 'custom', label: 'Custom — the values below' },
        { value: 'low', label: 'Low — detection only' },
        { value: 'high', label: 'High' },
        { value: 'critical', label: 'Critical — aggressive, contains' },
      ] },
      { id: 'min_rssi', label: 'Ignore rogues weaker than (dBm)', control: 'number', default: -80, min: -128, max: -70 },
      { id: 'timeout', label: 'Forget a rogue after (seconds)', control: 'number', default: 1200, min: 240, max: 3600 },
      { id: 'own_ssids', label: 'Your SSIDs (a rogue using one is malicious)', control: 'text', default: 'CORP, GUEST' },
      { id: 'wired_rule', label: 'A rogue seen on your wired network is malicious', control: 'toggle', default: true },
      { id: 'ap_profile', label: 'AP join profile to set detection on', control: 'text', default: 'default-ap-profile' },
      { id: 'report_interval', label: 'AP report interval (seconds)', control: 'number', default: 30, min: 10, max: 300 },
      { id: 'auto_contain', label: 'Contain automatically', control: 'toggle', default: false, hint: 'Legal sign-off first: containment attacks other people’s networks' },
      { id: 'contain_level', label: 'APs per rogue used to contain it', control: 'number', default: 1, min: 1, max: 4, showWhen: { input: 'auto_contain', equals: ['true'] } },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const level = str(values, 'security_level', 'custom');
      const rssi = num(values, 'min_rssi', -80);
      const timeout = num(values, 'timeout', 1200);
      const ssids = listOf(str(values, 'own_ssids', ''));
      const wired = bool(values, 'wired_rule', true);
      const profile = str(values, 'ap_profile', 'default-ap-profile').trim() || 'default-ap-profile';
      const contain = bool(values, 'auto_contain', false) || level === 'critical';
      const containLevel = num(values, 'contain_level', 1);
      const findings: Finding[] = [];
      if (rssi < -128 || rssi > -70) findings.push(error('network.wlc.bad-rogue-rssi', 'The minimum RSSI is between -128 and -70 dBm.', { source: 'ArchToolKit' }));
      else if (rssi < -90) {
        findings.push(warning('network.wlc.rogue-rssi-noise', `At ${rssi} dBm the controller reports access points in the next building. The rogue list fills with neighbours and the real one is lost in it.`, { remediation: 'Start at -80 and lower it only if a rogue you care about is being missed.', source: 'ArchToolKit' }));
      }
      if (timeout < 240 || timeout > 3600) findings.push(error('network.wlc.bad-rogue-timeout', 'The rogue timeout is between 240 and 3600 seconds.', { source: 'ArchToolKit' }));
      if (ssids.length === 0) {
        findings.push(warning('network.wlc.no-ssid-rule', 'No SSID rule: an access point broadcasting your own SSID — the evil twin that collects credentials — is classified like any neighbour.', { remediation: 'List the SSIDs you broadcast.', source: 'ArchToolKit' }));
      }
      if (contain) {
        findings.push(warning('network.wlc.auto-contain', 'Automatic containment sends deauthentication frames to clients of access points you do not own. In many countries that is unlawful interference with someone else’s network, whatever the policy says, and a misclassified neighbour gets attacked.', { remediation: 'Contain by hand, one rogue at a time, after confirming it is on your wire or impersonating your SSID — and only with legal sign-off.', source: 'ArchToolKit' }));
      }
      if (level !== 'custom') {
        findings.push(warning('network.wlc.rogue-level-overrides', `Security level ${level} sets its own thresholds and containment, overriding the values typed here.`, { remediation: 'Use custom to keep these values.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Rogue policy: ${ssids.length > 0 ? `SSID rule for ${ssids.join(', ')}` : 'no SSID rule'}${wired ? ', on-wire rule' : ''}${contain ? ', auto-contain' : ''}`,
        impact: contain ? 'brief' : 'none',
        notes: [
          'Detection is passive and changes nothing for clients. Containment is not: it spends AP airtime on deauthentication frames, and against a mis-classified neighbour it is an attack.',
          'The on-wire rule needs the controller to see the rogue’s clients on your wired network (Rogue Detector APs or switch-port tracing in Catalyst Center / Prime). Without that it never matches.',
          `The detection settings go on the AP join profile ${profile}: every AP with a site tag using it picks them up.`,
          'VERIFY: the rule sub-commands (classify, condition, match, shutdown) and `wireless wps rogue auto-contain` vary slightly between 17.x releases. Check each with `?` before the window.',
        ],
        before: ['show wireless wps rogue ap summary', 'show wireless wps rogue rule summary', 'show wireless wps rogue stats', `show ap profile name ${profile} detailed`],
        config: [
          `wireless wps rogue security-level ${level}`,
          ...(level === 'custom' ? [`wireless wps rogue ap notify-min-rssi ${rssi}`, `wireless wps rogue ap timeout ${timeout}`] : []),
          ...(ssids.length > 0
            ? ['wireless wps rogue rule RULE-SSID-SPOOF priority 1', ' classify malicious', ...ssids.map((s) => ` condition ssid ${s}`), ' match any', ' no shutdown', '!']
            : []),
          ...(wired ? [`wireless wps rogue rule RULE-ON-WIRE priority ${ssids.length > 0 ? 2 : 1}`, ' classify malicious', ' condition wired', ' match all', ' no shutdown', '!'] : []),
          `ap profile ${profile}`,
          ` rogue detection min-rssi ${rssi}`,
          ` rogue detection report-interval ${num(values, 'report_interval', 30)}`,
          '!',
          ...(contain && level === 'custom' ? [`wireless wps rogue auto-contain level ${containLevel}`] : []),
        ],
        verify: [
          'show wireless wps rogue rule summary',
          'show wireless wps rogue ap summary',
          'show wireless wps rogue ap summary | include Malicious',
          `show ap profile name ${profile} detailed | include Rogue`,
          ...(contain ? ['show wireless wps rogue ap list contained'] : []),
        ],
        backout: [
          ...(contain && level === 'custom' ? ['no wireless wps rogue auto-contain'] : []),
          ...(ssids.length > 0 ? ['no wireless wps rogue rule RULE-SSID-SPOOF'] : []),
          ...(wired ? ['no wireless wps rogue rule RULE-ON-WIRE'] : []),
          `ap profile ${profile}`,
          ' no rogue detection min-rssi',
          ' no rogue detection report-interval',
          '!',
          'wireless wps rogue security-level <previous level>',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_mdns_gateway',
    platform: PLATFORM,
    label: 'mDNS gateway and service policy',
    group: 'Services',
    description: 'Let clients find AirPlay, Chromecast and printers across VLANs: the controller learns the services and answers queries, filtered by a service policy, instead of flooding multicast over the air.',
    inputs: [
      { id: 'services', label: 'Services to allow', control: 'checklist', default: 'airplay,google-chromecast,printer-ipp,printer-ipps', options: MDNS_SERVICES },
      { id: 'service_policy', label: 'Service policy name', control: 'text', default: 'SP-CORP' },
      { id: 'policy_profile', label: 'Policy profile to attach it to', control: 'text', default: 'PP-CORP' },
      { id: 'wlan_profile', label: 'WLAN profile', control: 'text', default: 'WLAN-CORP' },
      { id: 'wlan_id', label: 'WLAN id', control: 'number', default: 1, min: 1, max: 4096 },
      { id: 'ssid', label: 'SSID', control: 'text', default: 'CORP' },
      { id: 'transport', label: 'Transport', control: 'select', default: 'ipv4', options: [
        { value: 'ipv4', label: 'IPv4' },
        { value: 'both', label: 'IPv4 and IPv6' },
        { value: 'ipv6', label: 'IPv6' },
      ] },
      { id: 'query_timer', label: 'Active query interval (minutes)', control: 'number', default: 30, min: 1, max: 120 },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const services = listOf(str(values, 'services', ''));
      const sp = upper(str(values, 'service_policy', ''), 'SP-MDNS');
      const pp = upper(str(values, 'policy_profile', ''), 'PP');
      const wlan = upper(str(values, 'wlan_profile', ''), 'WLAN');
      const id = num(values, 'wlan_id', 1);
      const ssid = str(values, 'ssid', 'CORP');
      const findings: Finding[] = [];
      if (services.length === 0) findings.push(error('network.wlc.no-mdns-services', 'No services: the gateway would learn nothing and answer nothing.', { source: 'ArchToolKit' }));
      const unknown = services.filter((s) => !MDNS_SERVICES.some((m) => m.value === s));
      if (unknown.length > 0) {
        findings.push(warning('network.wlc.unknown-mdns-service', `Not a built-in service definition: ${unknown.join(', ')}. It has to be defined first with mdns-sd service-definition.`, { source: 'ArchToolKit' }));
      }
      if (services.length > 6) {
        findings.push(warning('network.wlc.mdns-broad', 'Many services, with no location filtering: every client can see every advertised device across the whole controller — the boardroom screen from the car park.', { remediation: 'Narrow the list, or add location filtering (site tag or AP location) to the OUT service list.', source: 'ArchToolKit' }));
      }
      if (pp === 'DEFAULT-POLICY-PROFILE') {
        findings.push(warning('network.wlc.default-policy-profile', 'The default policy profile is used by every WLAN in the default policy tag. Attaching the service policy there applies it far wider than one SSID.', { source: 'ArchToolKit' }));
      }
      const listIn = `${sp}-IN`;
      const listOut = `${sp}-OUT`;

      return {
        platform: PLATFORM,
        title: `mDNS gateway for ${ssid}: ${services.join(', ')}`,
        impact: 'brief',
        notes: [
          `The WLAN ${wlan} is shut while its mDNS mode changes, which disconnects everyone on ${ssid} for a moment. Do it in a quiet period.`,
          'IN is what the controller learns from wireless clients and wired service providers; OUT is what it answers queries with. A service has to be in both to be found.',
          'Wired services (a printer on a switch) are learned only if the controller sees their mDNS: the VLAN has to reach the controller, or a switch acting as an mDNS service peer has to forward them.',
          'In FlexConnect local switching the controller does not see the traffic: use the AP as the mDNS gateway (flex profile) instead.',
          'VERIFY: service-definition names differ slightly by release; `show mdns-sd service-definition-list` (or `?` under a service list) shows this controller’s.',
        ],
        before: ['show mdns-sd summary', 'show running-config | section mdns-sd', `show wlan name ${wlan}`, `show wireless profile policy detailed ${pp}`],
        config: [
          'mdns-sd gateway',
          ` transport ${str(values, 'transport', 'ipv4')}`,
          ` active-query timer ${num(values, 'query_timer', 30)}`,
          '!',
          `mdns-sd service-list ${listIn} IN`,
          ...services.map((s) => ` match ${s}`),
          '!',
          `mdns-sd service-list ${listOut} OUT`,
          ...services.map((s) => ` match ${s}`),
          '!',
          `mdns-sd service-policy ${sp}`,
          ` service-list ${listIn} IN`,
          ` service-list ${listOut} OUT`,
          '!',
          `wlan ${wlan} ${id} ${ssid}`,
          ' shutdown',
          ' mdns-sd-interface gateway',
          ' no shutdown',
          '!',
          `wireless profile policy ${pp}`,
          ` mdns-sd service-policy ${sp}`,
          '!',
        ],
        verify: ['show mdns-sd summary', 'show mdns-sd cache', `show mdns-sd service-policy name ${sp}`, 'show mdns-sd statistics', 'From a client, check the AirPlay or printer list shows the devices it should, and only those.'],
        backout: [
          `wireless profile policy ${pp}`,
          ` no mdns-sd service-policy ${sp}`,
          '!',
          `wlan ${wlan} ${id} ${ssid}`,
          ' shutdown',
          ' mdns-sd-interface bridge',
          ' no shutdown',
          '!',
          `no mdns-sd service-policy ${sp}`,
          `no mdns-sd service-list ${listIn} IN`,
          `no mdns-sd service-list ${listOut} OUT`,
          'no mdns-sd gateway',
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_avc',
    platform: PLATFORM,
    label: 'Application visibility and control (AVC)',
    group: 'Services',
    description: 'NBAR on a policy profile so the controller sees which applications each client uses, a flow monitor that keeps the records locally and optionally exports them, and a policy that marks down or drops the applications you choose.',
    inputs: [
      { id: 'policy_profile', label: 'Policy profile', control: 'text', default: 'PP-CORP' },
      { id: 'ipv6', label: 'Also for IPv6 traffic', control: 'toggle', default: true },
      { id: 'collector', label: 'External NetFlow collector', control: 'text', default: '', hint: 'IPFIX collector address. Empty for local only' },
      { id: 'collector_port', label: 'Collector port', control: 'number', default: 2055, min: 1, max: 65535, showWhen: { input: 'collector', notEquals: [''] } },
      { id: 'control_apps', label: 'Applications to control', control: 'text', default: 'netflix, youtube, bittorrent', hint: 'NBAR protocol names. Empty for visibility only' },
      { id: 'action', label: 'What to do with them', control: 'select', default: 'mark', options: [
        { value: 'mark', label: 'Mark down to CS1 (scavenger)' },
        { value: 'drop', label: 'Drop' },
      ] },
    ],
    change: (values: BlueprintValues): DeviceChange => {
      const pp = upper(str(values, 'policy_profile', ''), 'PP');
      const v6 = bool(values, 'ipv6', true);
      const collector = str(values, 'collector', '').trim();
      const apps = listOf(str(values, 'control_apps', '')).map((a) => a.toLowerCase());
      const action = str(values, 'action', 'mark');
      const findings: Finding[] = [];
      if (collector && !isIp(collector)) findings.push(error('network.wlc.bad-collector', `The collector "${collector}" is not an address.`, { source: 'ArchToolKit' }));
      const badApps = apps.filter((a) => !/^[a-z0-9][a-z0-9_-]*$/.test(a));
      if (badApps.length > 0) findings.push(error('network.wlc.bad-nbar-protocol', `Not an NBAR protocol name: ${badApps.join(', ')}.`, { remediation: 'Use the names `match protocol ?` lists.', source: 'ArchToolKit' }));
      if (apps.length > 0 && action === 'drop') {
        findings.push(warning('network.wlc.avc-drop', 'Dropping by application is decided by NBAR’s classification, which is wrong sometimes — and a drop is silent to the user, who sees an application that half works.', { remediation: 'Mark down first, watch the classification for a week, then decide.', source: 'ArchToolKit' }));
      }
      if (pp === 'DEFAULT-POLICY-PROFILE') {
        findings.push(warning('network.wlc.default-policy-profile', 'The default policy profile is used by every WLAN in the default policy tag. AVC there applies far wider than one SSID.', { source: 'ArchToolKit' }));
      }
      const mon4 = 'AVC-MON-V4';
      const mon6 = 'AVC-MON-V6';
      const exporters = ['AVC-LOCAL', ...(collector ? ['AVC-EXPORT'] : [])];
      const control = apps.length > 0 && badApps.length === 0;

      return {
        platform: PLATFORM,
        title: `AVC on ${pp}${control ? `, ${action === 'drop' ? 'dropping' : 'marking down'} ${apps.join(', ')}` : ''}`,
        impact: 'outage',
        notes: [
          `The policy profile ${pp} is shut while the flow monitors are attached. Every client on every WLAN that uses it disconnects and rejoins. Do it in a window.`,
          'AVC classifies traffic the controller switches. With FlexConnect local switching the AP does the classification, and the flow monitor goes on the flex policy instead.',
          'The local exporter keeps the records on the controller for Monitoring > Services > Application Visibility. An external collector gets IPFIX on top of that.',
          ...(control ? ['The QoS policy works on the classification: an application NBAR does not recognise yet (a new version, encrypted SNI) passes unmarked.'] : []),
        ],
        before: [`show wireless profile policy detailed ${pp}`, 'show flow monitor', 'show flow exporter', 'show policy-map'],
        config: [
          'flow exporter AVC-LOCAL',
          ' destination local wlc',
          '!',
          ...(collector && isIp(collector)
            ? ['flow exporter AVC-EXPORT', ` destination ${collector}`, ` transport udp ${num(values, 'collector_port', 2055)}`, ' export-protocol ipfix', '!']
            : []),
          `flow monitor ${mon4}`,
          ...exporters.map((e) => ` exporter ${e}`),
          ' record wireless avc basic',
          '!',
          ...(v6 ? [`flow monitor ${mon6}`, ...exporters.map((e) => ` exporter ${e}`), ' record wireless avc ipv6 basic', '!'] : []),
          ...(control
            ? [
                'class-map match-any CM-AVC-CONTROL',
                ...apps.map((a) => ` match protocol ${a}`),
                '!',
                'policy-map PM-AVC-CONTROL',
                ' class CM-AVC-CONTROL',
                action === 'drop' ? '  drop' : '  set dscp cs1',
                '!',
              ]
            : []),
          `wireless profile policy ${pp}`,
          ' shutdown',
          ' ip nbar protocol-discovery',
          ` ip flow monitor ${mon4} input`,
          ` ip flow monitor ${mon4} output`,
          ...(v6 ? [` ipv6 flow monitor ${mon6} input`, ` ipv6 flow monitor ${mon6} output`] : []),
          ...(control ? [' service-policy input PM-AVC-CONTROL', ' service-policy output PM-AVC-CONTROL'] : []),
          ' no shutdown',
          '!',
        ],
        verify: [
          `show wireless profile policy detailed ${pp} | include AVC|flow|NBAR`,
          'show avc wireless top 10 applications aggregate upstream',
          'show avc client <client-mac> top 10 application aggregate',
          ...(collector ? ['show flow exporter AVC-EXPORT statistics'] : []),
          ...(control ? ['show policy-map interface wireless client mac <client-mac>'] : []),
        ],
        backout: [
          `wireless profile policy ${pp}`,
          ' shutdown',
          ...(control ? [' no service-policy input PM-AVC-CONTROL', ' no service-policy output PM-AVC-CONTROL'] : []),
          ` no ip flow monitor ${mon4} input`,
          ` no ip flow monitor ${mon4} output`,
          ...(v6 ? [` no ipv6 flow monitor ${mon6} input`, ` no ipv6 flow monitor ${mon6} output`] : []),
          ' no ip nbar protocol-discovery',
          ' no shutdown',
          '!',
          ...(control ? ['no policy-map PM-AVC-CONTROL', 'no class-map match-any CM-AVC-CONTROL'] : []),
          ...(v6 ? [`no flow monitor ${mon6}`] : []),
          `no flow monitor ${mon4}`,
          ...(collector && isIp(collector) ? ['no flow exporter AVC-EXPORT'] : []),
          'no flow exporter AVC-LOCAL',
        ],
        findings: [
          ...findings,
          ...(collector && familyOf(collector) === 6
            ? [warning('network.wlc.collector-ipv6', 'VERIFY: an IPv6 flow exporter destination needs a release that supports it; check `destination ?` on this controller.', { source: 'ArchToolKit' })]
            : []),
        ],
      };
    },
  }),
];

/**
 * Cisco Catalyst 9800 wireless LAN controllers.
 *
 * The 9800 is IOS-XE, so the syntax reads like a switch — but the model does
 * not. Nothing on a 9800 applies to an access point directly: a WLAN is joined
 * to a policy profile inside a policy tag, the policy tag is attached to APs by
 * a site tag and an RF tag, and an AP only picks any of it up when its tags are
 * assigned. That is why the tag blueprint exists and why every WLAN change here
 * says which profile and tag it belongs to.
 *
 * Wireless changes are also the ones most likely to take a floor offline while
 * everyone is on it, so the impact levels here are deliberately pessimistic.
 *
 * No key is ever written: PSKs, RADIUS secrets and the rest are `<REQUIRED>`.
 */

import { bool, num, str,                                           } from '../../kit/blueprint.js';
import { error, warning,              } from '../../core/findings.js';
import { deviceBlueprint,                      } from '../from-change.js';
import { listOf, parseCidr, netmask,                   } from '../device.js';

const PLATFORM = 'cisco_wlc'         ;
const SECRET = '<REQUIRED>';

const BLUEPRINTS                             = [
  deviceBlueprint({
    id: 'wlc_wlan_enterprise',
    platform: PLATFORM,
    label: 'WLAN — WPA2/WPA3 Enterprise (802.1X)',
    group: 'WLANs',
    description: 'An 802.1X SSID authenticated against RADIUS, with its policy profile and the VLAN it lands in.',
    inputs: [
      { id: 'ssid', label: 'SSID', control: 'text', default: 'CORP', hint: 'What people see. Case sensitive' },
      { id: 'profile_name', label: 'WLAN profile name', control: 'text', default: 'WLAN-CORP' },
      { id: 'wlan_id', label: 'WLAN id', control: 'number', default: 1, min: 1, max: 4096 },
      { id: 'policy_profile', label: 'Policy profile', control: 'text', default: 'PP-CORP' },
      { id: 'vlan_id', label: 'VLAN', control: 'number', default: 20, min: 1, max: 4094, hint: 'Where clients land, for central switching' },
      { id: 'radius_group', label: 'RADIUS server group', control: 'text', default: 'ISE-GROUP', hint: 'Created by the RADIUS change' },
      { id: 'security', label: 'Security', control: 'select', default: 'wpa2', options: [
        { value: 'wpa2', label: 'WPA2 Enterprise (AES)' },
        { value: 'wpa3', label: 'WPA3 Enterprise' },
        { value: 'wpa2-wpa3', label: 'WPA2 + WPA3 transition' },
      ] },
      { id: 'band_select', label: 'Band select (push clients to 5 GHz)', control: 'toggle', default: true },
      { id: 'broadcast', label: 'Broadcast the SSID', control: 'toggle', default: true, hint: 'Hiding it is not security, and it breaks some clients' },
      { id: 'fast_transition', label: '802.11r fast transition', control: 'select', default: 'adaptive', options: [
        { value: 'adaptive', label: 'Adaptive (safest with mixed clients)' },
        { value: 'enabled', label: 'Enabled' },
        { value: 'disabled', label: 'Disabled' },
      ] },
      { id: 'aaa_override', label: 'AAA override (let RADIUS set the VLAN)', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const ssid = str(values, 'ssid', 'CORP');
      const profile = str(values, 'profile_name', 'WLAN').toUpperCase().replace(/\s+/g, '-');
      const id = num(values, 'wlan_id', 1);
      const policy = str(values, 'policy_profile', 'PP').toUpperCase().replace(/\s+/g, '-');
      const vlan = num(values, 'vlan_id', 20);
      const group = str(values, 'radius_group', 'ISE-GROUP');
      const security = str(values, 'security', 'wpa2');
      const findings            = [];
      if (!bool(values, 'broadcast', true)) {
        findings.push(
          warning('network.wlc.hidden-ssid', 'A hidden SSID is not hidden — clients probe for it by name, which is worse — and it breaks onboarding on several platforms.', {
            source: 'ArchToolKit',
          }),
        );
      }
      if (security === 'wpa3') {
        findings.push(
          warning('network.wlc.wpa3-only', 'WPA3-only will refuse older clients outright. Use the transition mode unless you know every client supports it.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `WLAN ${ssid} (802.1X) on VLAN ${vlan}`,
        impact: 'brief',
        notes: [
          `The RADIUS server group ${group} has to exist first, and the controller must be a network device on the RADIUS server with a matching shared secret.`,
          `Nothing broadcasts until the policy profile ${policy} is in a policy tag and that tag is on the APs. The tag change does that.`,
          'Creating a WLAN does not disturb the others; putting it in a policy tag does, briefly, because the APs reload their configuration.',
        ],
        before: ['show wlan summary', `show wlan id ${id}`, 'show wireless profile policy summary', 'show wireless tag policy summary'],
        config: [
          `wlan ${profile} ${id} ${ssid}`,
          ...(security === 'wpa3'
            ? [' security wpa psk', ' no security wpa wpa2', ' security wpa wpa3', ' security wpa wpa3 ciphers aes', ' security dot1x authentication-list default']
            : security === 'wpa2-wpa3'
              ? [' security wpa wpa2', ' security wpa wpa3', ' security wpa wpa2 ciphers aes', ' security dot1x authentication-list default']
              : [' security wpa wpa2', ' security wpa wpa2 ciphers aes', ' security dot1x authentication-list default']),
          ` security dot1x authentication-list ${group}`,
          ...(str(values, 'fast_transition', 'adaptive') === 'adaptive'
            ? [' security ft adaptive']
            : str(values, 'fast_transition', '') === 'enabled'
              ? [' security ft', ' security ft over-the-ds']
              : [' no security ft']),
          ...(bool(values, 'band_select', true) ? [' band-select'] : []),
          bool(values, 'broadcast', true) ? ' broadcast-ssid' : ' no broadcast-ssid',
          ' no shutdown',
          '!',
          `wireless profile policy ${policy}`,
          ` description Policy for ${ssid}`,
          ...(bool(values, 'aaa_override', true) ? [' aaa-override'] : []),
          ' accounting-list default',
          ' central association',
          ' central dhcp',
          ' central switching',
          ' description',
          ` vlan ${vlan}`,
          ' no shutdown',
          '!',
        ],
        verify: [
          `show wlan id ${id}`,
          `show wireless profile policy detailed ${policy}`,
          'show wireless client summary',
          `show wireless stats client detail`,
        ],
        backout: [`wlan ${profile} ${id} ${ssid}`, ' shutdown', '!', `no wlan ${profile} ${id} ${ssid}`, `no wireless profile policy ${policy}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_wlan_psk',
    platform: PLATFORM,
    label: 'WLAN — WPA2/WPA3 Personal (pre-shared key)',
    group: 'WLANs',
    description: 'A PSK SSID for devices that cannot do 802.1X — printers, scanners, building systems — with the key left as a placeholder.',
    inputs: [
      { id: 'ssid', label: 'SSID', control: 'text', default: 'IOT' },
      { id: 'profile_name', label: 'WLAN profile name', control: 'text', default: 'WLAN-IOT' },
      { id: 'wlan_id', label: 'WLAN id', control: 'number', default: 5, min: 1, max: 4096 },
      { id: 'policy_profile', label: 'Policy profile', control: 'text', default: 'PP-IOT' },
      { id: 'vlan_id', label: 'VLAN', control: 'number', default: 50, min: 1, max: 4094 },
      { id: 'security', label: 'Security', control: 'select', default: 'wpa2', options: [
        { value: 'wpa2', label: 'WPA2 Personal' },
        { value: 'wpa3-sae', label: 'WPA3 Personal (SAE)' },
        { value: 'transition', label: 'WPA2 + WPA3 transition' },
      ] },
      { id: 'client_isolation', label: 'Peer-to-peer blocking', control: 'toggle', default: true, hint: 'Stops clients on this SSID talking to each other' },
      { id: 'max_clients', label: 'Maximum clients per WLAN', control: 'number', default: 0, min: 0, hint: '0 for no limit' },
    ],
    change: (values                 )               => {
      const ssid = str(values, 'ssid', 'IOT');
      const profile = str(values, 'profile_name', 'WLAN').toUpperCase().replace(/\s+/g, '-');
      const id = num(values, 'wlan_id', 5);
      const policy = str(values, 'policy_profile', 'PP').toUpperCase().replace(/\s+/g, '-');
      const vlan = num(values, 'vlan_id', 50);
      const security = str(values, 'security', 'wpa2');
      const maximum = num(values, 'max_clients', 0);
      const findings            = [
        warning('network.wlc.psk-rotation', 'A pre-shared key is shared by every device on the SSID: it cannot be revoked for one of them, and it leaves with anyone who leaves.', {
          remediation: 'Use 802.1X where the devices support it, and identity PSK where they do not.',
          source: 'ArchToolKit',
        }),
      ];

      return {
        platform: PLATFORM,
        title: `WLAN ${ssid} (PSK) on VLAN ${vlan}`,
        impact: 'brief',
        notes: [
          `Replace ${SECRET} with the key. Nothing generated here contains one, and the key should come from your password store, not from a chat message.`,
          'Peer-to-peer blocking is what stops one compromised device on an IoT SSID reaching the rest.',
        ],
        before: ['show wlan summary', `show wlan id ${id}`, 'show wireless profile policy summary'],
        config: [
          `wlan ${profile} ${id} ${ssid}`,
          ...(security === 'wpa3-sae'
            ? [' no security wpa wpa2', ' security wpa psk set-key ascii 0 ' + SECRET, ' security wpa wpa3', ' security wpa wpa3 ciphers aes', ' security wpa akm sae', ' security pmf mandatory']
            : security === 'transition'
              ? [' security wpa psk set-key ascii 0 ' + SECRET, ' security wpa wpa2', ' security wpa wpa3', ' security wpa akm psk', ' security wpa akm sae', ' security pmf optional']
              : [' security wpa psk set-key ascii 0 ' + SECRET, ' security wpa wpa2', ' security wpa wpa2 ciphers aes', ' security wpa akm psk']),
          ' no security wpa akm dot1x',
          ...(maximum > 0 ? [` client association limit ${maximum}`] : []),
          ' no shutdown',
          '!',
          `wireless profile policy ${policy}`,
          ` description Policy for ${ssid}`,
          ` vlan ${vlan}`,
          ...(bool(values, 'client_isolation', true) ? [' ipv4 dhcp required', ' peer-blocking drop'] : []),
          ' central switching',
          ' central dhcp',
          ' no shutdown',
          '!',
        ],
        verify: [`show wlan id ${id}`, `show wireless profile policy detailed ${policy}`, 'show wireless client summary', `show wireless client mac-address <mac> detail`],
        backout: [`wlan ${profile} ${id} ${ssid}`, ' shutdown', '!', `no wlan ${profile} ${id} ${ssid}`, `no wireless profile policy ${policy}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_guest_wlan',
    platform: PLATFORM,
    label: 'Guest WLAN with web authentication',
    group: 'WLANs',
    description: 'An open guest SSID behind a captive portal, in its own VLAN, with client isolation and a rate limit.',
    inputs: [
      { id: 'ssid', label: 'SSID', control: 'text', default: 'GUEST' },
      { id: 'profile_name', label: 'WLAN profile name', control: 'text', default: 'WLAN-GUEST' },
      { id: 'wlan_id', label: 'WLAN id', control: 'number', default: 10, min: 1, max: 4096 },
      { id: 'policy_profile', label: 'Policy profile', control: 'text', default: 'PP-GUEST' },
      { id: 'vlan_id', label: 'Guest VLAN', control: 'number', default: 100, min: 1, max: 4094 },
      { id: 'parameter_map', label: 'Web auth parameter map', control: 'text', default: 'GUEST-PORTAL' },
      { id: 'portal_type', label: 'Portal', control: 'select', default: 'consent', options: [
        { value: 'consent', label: 'Consent — accept the terms and go' },
        { value: 'webauth', label: 'Credentials — username and password' },
        { value: 'external', label: 'External portal (ISE or a guest system)' },
      ] },
      { id: 'external_url', label: 'External portal URL', control: 'text', default: '', showWhen: { input: 'portal_type', equals: ['external'] } },
      { id: 'rate_limit_kbps', label: 'Per-client rate limit (kbps)', control: 'number', default: 5000, min: 0, hint: '0 for none' },
      { id: 'session_timeout', label: 'Session timeout (seconds)', control: 'number', default: 28800, min: 60 },
    ],
    change: (values                 )               => {
      const ssid = str(values, 'ssid', 'GUEST');
      const profile = str(values, 'profile_name', 'WLAN-GUEST').toUpperCase().replace(/\s+/g, '-');
      const id = num(values, 'wlan_id', 10);
      const policy = str(values, 'policy_profile', 'PP-GUEST').toUpperCase().replace(/\s+/g, '-');
      const vlan = num(values, 'vlan_id', 100);
      const map = str(values, 'parameter_map', 'GUEST-PORTAL').toUpperCase().replace(/\s+/g, '-');
      const kind = str(values, 'portal_type', 'consent');
      const rate = num(values, 'rate_limit_kbps', 5000);
      const findings            = [
        warning('network.wlc.guest-open', 'A guest SSID with web authentication is an open network: everything before the portal, and everything the portal does not encrypt, is in the clear over the air.', {
          remediation: 'Terminate guests outside the firewall, isolate them from everything internal, and say so in the terms.',
          source: 'ArchToolKit',
        }),
      ];

      return {
        platform: PLATFORM,
        title: `Guest WLAN ${ssid} with a captive portal`,
        impact: 'brief',
        notes: [
          'The guest VLAN should terminate outside, not inside. A guest network with a route to the corporate VLAN is not a guest network.',
          'The portal needs a certificate the clients trust, or every guest sees a warning before they can accept anything.',
          ...(kind === 'external' ? ['An external portal needs the redirect ACL permitting DNS and the portal address before authentication.'] : []),
        ],
        before: ['show wlan summary', `show wlan id ${id}`, 'show parameter-map type webauth summary', 'show wireless client summary'],
        config: [
          `parameter-map type webauth ${map}`,
          ...(kind === 'consent' ? [' type consent', ' consent email'] : kind === 'webauth' ? [' type webauth'] : [' type webauth', ` redirect for-login ${str(values, 'external_url', '')}`, ' redirect portal ipv4 <portal-address>']),
          ' banner text ^Guest access. Use of this network is logged.^',
          '!',
          `wlan ${profile} ${id} ${ssid}`,
          ' no security wpa',
          ' no security wpa akm dot1x',
          ' no security wpa wpa2',
          ' no security wpa wpa2 ciphers aes',
          ' security web-auth',
          ` security web-auth parameter-map ${map}`,
          ' security web-auth authentication-list default',
          ' no shutdown',
          '!',
          `wireless profile policy ${policy}`,
          ` description Guest policy for ${ssid}`,
          ` vlan ${vlan}`,
          ' ipv4 dhcp required',
          ' peer-blocking drop',
          ...(rate > 0 ? [` police rate ${rate} conform-action transmit exceed-action drop`] : []),
          ` session-timeout ${num(values, 'session_timeout', 28800)}`,
          ' central switching',
          ' central dhcp',
          ' no shutdown',
          '!',
        ],
        verify: [`show wlan id ${id}`, `show parameter-map type webauth ${map}`, 'show wireless client summary', 'Connect a phone and check the portal appears before anything else does.'],
        backout: [`wlan ${profile} ${id} ${ssid}`, ' shutdown', '!', `no wlan ${profile} ${id} ${ssid}`, `no wireless profile policy ${policy}`, `no parameter-map type webauth ${map}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_tags',
    platform: PLATFORM,
    label: 'Tags: policy, site and RF',
    group: 'Tags and profiles',
    description: 'The tags that actually put a WLAN on an access point, and the AP assignments that apply them.',
    inputs: [
      { id: 'policy_tag', label: 'Policy tag', control: 'text', default: 'PT-CAMPUS' },
      { id: 'mappings', label: 'WLAN to policy profile', control: 'textarea', default: 'WLAN-CORP PP-CORP\nWLAN-GUEST PP-GUEST', hint: 'One per line: WLAN-profile policy-profile' },
      { id: 'site_tag', label: 'Site tag', control: 'text', default: 'ST-CAMPUS' },
      { id: 'ap_profile', label: 'AP join profile', control: 'text', default: 'APJP-CAMPUS' },
      { id: 'local_site', label: 'Local site (central switching)', control: 'toggle', default: true, hint: 'Off means FlexConnect: the APs switch traffic locally' },
      { id: 'rf_tag', label: 'RF tag', control: 'text', default: 'RT-CAMPUS' },
      { id: 'aps', label: 'Access points to tag', control: 'textarea', default: '', hint: 'One per line: MAC-address name — or leave empty and tag them by rule' },
    ],
    change: (values                 )               => {
      const policyTag = str(values, 'policy_tag', 'PT').toUpperCase().replace(/\s+/g, '-');
      const siteTag = str(values, 'site_tag', 'ST').toUpperCase().replace(/\s+/g, '-');
      const rfTag = str(values, 'rf_tag', 'RT').toUpperCase().replace(/\s+/g, '-');
      const mappings = str(values, 'mappings', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2);
      const aps = str(values, 'aps', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 1 && parts[0] !== '');
      const findings            = [];
      if (mappings.length === 0) {
        findings.push(error('network.wlc.no-mappings', 'A policy tag with no WLANs in it broadcasts nothing.', { remediation: 'Map at least one WLAN profile to a policy profile.', source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Tags ${policyTag} / ${siteTag} / ${rfTag}${aps.length > 0 ? ` on ${aps.length} AP(s)` : ''}`,
        impact: 'outage',
        notes: [
          '**Changing an AP’s tags restarts its CAPWAP tunnel.** Every client on that AP is disconnected and reassociates. Do it out of hours, floor by floor.',
          'The profiles named here must exist already — the WLAN changes create the policy profiles, the AP join profile change creates the AP profile.',
          'A site tag that is not "local site" is FlexConnect. Getting that wrong changes where client traffic is switched, which changes which VLANs have to exist at the edge.',
        ],
        before: ['show wireless tag policy summary', 'show wireless tag site summary', 'show wireless tag rf summary', 'show ap tag summary', 'show ap summary'],
        config: [
          `wireless tag policy ${policyTag}`,
          ' description',
          ...mappings.flatMap((parts) => [` wlan ${parts[0]} policy ${parts[1]}`]),
          '!',
          `wireless tag site ${siteTag}`,
          ' description',
          ` ap-profile ${str(values, 'ap_profile', 'default-ap-profile')}`,
          ...(bool(values, 'local_site', true) ? [' local-site'] : [' no local-site']),
          '!',
          `wireless tag rf ${rfTag}`,
          ' description',
          '!',
          ...aps.flatMap((parts) => [
            `ap ${parts[0]}`,
            ...(parts[1] ? [` name ${parts[1]}`] : []),
            ` policy-tag ${policyTag}`,
            ` site-tag ${siteTag}`,
            ` rf-tag ${rfTag}`,
            '!',
          ]),
        ],
        verify: ['show ap tag summary', 'show ap summary', 'show wireless tag policy detailed ' + policyTag, 'show wireless client summary'],
        backout: [
          ...aps.map((parts) => `ap ${parts[0]} policy-tag default-policy-tag site-tag default-site-tag rf-tag default-rf-tag`),
          `no wireless tag policy ${policyTag}`,
          `no wireless tag site ${siteTag}`,
          `no wireless tag rf ${rfTag}`,
        ],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_rf_profile',
    platform: PLATFORM,
    label: 'RF profile',
    group: 'Tags and profiles',
    description: 'Per-band radio settings: data rates, power and channel ranges, and the client density behaviour for a high-density space.',
    inputs: [
      { id: 'profile_name', label: 'RF profile name', control: 'text', default: 'RF-HIGH-DENSITY' },
      { id: 'band', label: 'Band', control: 'select', default: '5ghz', options: [
        { value: '5ghz', label: '5 GHz' },
        { value: '24ghz', label: '2.4 GHz' },
        { value: '6ghz', label: '6 GHz' },
      ] },
      { id: 'density', label: 'Space', control: 'select', default: 'high', options: [
        { value: 'high', label: 'High density — lecture hall, open office' },
        { value: 'standard', label: 'Standard office' },
        { value: 'coverage', label: 'Coverage — warehouse, outdoors' },
      ] },
      { id: 'minimum_rate', label: 'Lowest mandatory data rate (Mbps)', control: 'select', default: '12', options: [
        { value: '6', label: '6 — widest coverage' },
        { value: '12', label: '12 — balanced' },
        { value: '24', label: '24 — high density' },
      ] },
      { id: 'tx_power_min', label: 'Minimum transmit power (dBm)', control: 'number', default: 8, min: -10, max: 30 },
      { id: 'tx_power_max', label: 'Maximum transmit power (dBm)', control: 'number', default: 14, min: -10, max: 30 },
      { id: 'channel_width', label: 'Channel width (MHz)', control: 'select', default: '20', options: [
        { value: '20', label: '20 — most channels, least interference' },
        { value: '40', label: '40' },
        { value: '80', label: '80 — fastest, fewest channels' },
      ] },
    ],
    change: (values                 )               => {
      const name = str(values, 'profile_name', 'RF').toUpperCase().replace(/\s+/g, '-');
      const band = str(values, 'band', '5ghz');
      const density = str(values, 'density', 'high');
      const minimum = num(values, 'minimum_rate', 12);
      const width = num(values, 'channel_width', 20);
      const findings            = [];
      if (band === '24ghz' && width > 20) {
        findings.push(error('network.wlc.24ghz-width', '2.4 GHz has three non-overlapping channels at 20 MHz. Anything wider guarantees interference.', { source: 'ArchToolKit' }));
      }
      if (density === 'high' && minimum < 12) {
        findings.push(
          warning('network.wlc.low-data-rate', 'In a high-density space, leaving low data rates enabled lets distant clients hold the air for far longer than they should.', {
            remediation: 'Disable rates below 12 Mbps and make 12 mandatory.',
            source: 'ArchToolKit',
          }),
        );
      }

      const bandCommand = band === '24ghz' ? 'ap dot11 24ghz rf-profile' : band === '6ghz' ? 'ap dot11 6ghz rf-profile' : 'ap dot11 5ghz rf-profile';

      return {
        platform: PLATFORM,
        title: `RF profile ${name} (${band}, ${density})`,
        impact: 'brief',
        notes: [
          'An RF profile only applies where an RF tag carries it. Creating it changes nothing on its own.',
          'Disabling low data rates drops clients that can only reach the AP at those rates. In a survey-backed design that is the point; without one it is a coverage hole.',
          'Change the minimum rate on one RF tag first and watch the client count before rolling it out.',
        ],
        before: [`show ap rf-profile summary`, `show ap rf-profile name ${name} detail`, 'show ap dot11 ' + (band === '24ghz' ? '24ghz' : '5ghz') + ' summary'],
        config: [
          `${bandCommand} ${name}`,
          ' description',
          ...(band !== '6ghz'
            ? [
                ...(minimum >= 12 ? [' rate rate-6m disable', ' rate rate-9m disable'] : []),
                ...(minimum >= 24 ? [' rate rate-12m disable', ' rate rate-18m disable'] : []),
                ` rate rate-${minimum}m mandatory`,
              ]
            : []),
          ` tx-power min ${num(values, 'tx_power_min', 8)}`,
          ` tx-power max ${num(values, 'tx_power_max', 14)}`,
          ...(band !== '24ghz' ? [` channel width ${width}`] : []),
          ...(density === 'high' ? [' coverage data rssi threshold -75', ' load-balancing window 3', ' load-balancing denial 3'] : []),
          ...(density === 'coverage' ? [' coverage data rssi threshold -85'] : []),
          ' no shutdown',
          '!',
        ],
        verify: [`show ap rf-profile name ${name} detail`, 'show ap dot11 ' + (band === '24ghz' ? '24ghz' : '5ghz') + ' summary', 'show wireless client summary'],
        backout: [`no ${bandCommand} ${name}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_ap_join_profile',
    platform: PLATFORM,
    label: 'AP join profile',
    group: 'Tags and profiles',
    description: 'What an access point gets when it joins: its mode, management access, syslog, and the CAPWAP timers.',
    inputs: [
      { id: 'profile_name', label: 'Profile name', control: 'text', default: 'APJP-CAMPUS' },
      { id: 'ap_mode', label: 'AP mode', control: 'select', default: 'local', options: [
        { value: 'local', label: 'Local — the AP serves clients' },
        { value: 'flexconnect', label: 'FlexConnect — local switching at a branch' },
        { value: 'monitor', label: 'Monitor — scanning only' },
        { value: 'sniffer', label: 'Sniffer — packet capture' },
      ] },
      { id: 'ssh', label: 'SSH access to the APs', control: 'toggle', default: true, hint: 'For troubleshooting; needs credentials' },
      { id: 'syslog_host', label: 'AP syslog server', control: 'text', default: '10.0.0.20' },
      { id: 'syslog_level', label: 'Syslog level', control: 'select', default: 'informational', options: [
        { value: 'informational', label: 'Informational' },
        { value: 'warnings', label: 'Warnings' },
        { value: 'errors', label: 'Errors' },
      ] },
      { id: 'led_state', label: 'AP LEDs on', control: 'toggle', default: true },
      { id: 'capwap_timers', label: 'Tune CAPWAP timers for a WAN', control: 'toggle', default: false, hint: 'Longer retransmit intervals for APs across a slow or lossy link' },
    ],
    change: (values                 )               => {
      const name = str(values, 'profile_name', 'APJP').toUpperCase().replace(/\s+/g, '-');
      const mode = str(values, 'ap_mode', 'local');
      const ssh = bool(values, 'ssh', true);

      return {
        platform: PLATFORM,
        title: `AP join profile ${name} (${mode} mode)`,
        impact: 'outage',
        notes: [
          '**Changing the AP mode reboots the access point.** Every client on it drops and reassociates elsewhere, if there is an elsewhere.',
          'The profile applies through a site tag. Creating it changes nothing until a tag carries it.',
          ...(ssh ? [`The AP management credentials are ${SECRET}. They are not generated here, and they should not match the controller's.`] : []),
        ],
        before: ['show ap profile summary', `show ap profile name ${name} detailed`, 'show ap summary'],
        config: [
          `ap profile ${name}`,
          ' description',
          ...(ssh ? [' mgmtuser username admin password 0 ' + SECRET + ' secret 0 ' + SECRET, ' ssh'] : [' no ssh']),
          ...(bool(values, 'led_state', true) ? [' led'] : [' no led']),
          ` syslog host ${str(values, 'syslog_host', '')}`,
          ` syslog level ${str(values, 'syslog_level', 'informational')}`,
          ...(bool(values, 'capwap_timers', false) ? [' capwap retransmit interval 5', ' capwap retransmit count 5'] : []),
          ' no shutdown',
          '!',
          ...(mode !== 'local' ? [`! Set the mode per AP or through the site tag: ap name <ap> mode ${mode}`] : []),
        ],
        verify: [`show ap profile name ${name} detailed`, 'show ap summary', 'show ap config general | include Mode|Join'],
        backout: [`no ap profile ${name}`],
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_radius',
    platform: PLATFORM,
    label: 'RADIUS servers and CoA',
    group: 'Baseline',
    description: 'The RADIUS servers an 802.1X WLAN authenticates against, the server group, and change-of-authorisation so ISE can move a client mid-session.',
    inputs: [
      { id: 'servers', label: 'RADIUS servers', control: 'text', default: '10.0.0.30, 10.0.0.31' },
      { id: 'group_name', label: 'Server group', control: 'text', default: 'ISE-GROUP' },
      { id: 'source_interface', label: 'Source interface', control: 'text', default: 'Vlan10' },
      { id: 'coa', label: 'Change of authorisation', control: 'toggle', default: true, hint: 'Lets ISE quarantine or re-authorise a client without disconnecting it' },
      { id: 'accounting', label: 'Accounting', control: 'toggle', default: true },
      { id: 'dead_criteria', label: 'Mark a server dead after (seconds)', control: 'number', default: 10, min: 1, max: 120 },
    ],
    change: (values                 )               => {
      const servers = listOf(str(values, 'servers', ''));
      const group = str(values, 'group_name', 'ISE-GROUP').toUpperCase().replace(/\s+/g, '-');
      const coa = bool(values, 'coa', true);
      const findings            = [];
      if (servers.length < 2) {
        findings.push(
          warning('network.wlc.single-radius', 'One RADIUS server means every 802.1X SSID stops authenticating when it is patched.', { source: 'ArchToolKit' }),
        );
      }

      return {
        platform: PLATFORM,
        title: `RADIUS group ${group} with ${servers.length} server(s)`,
        impact: 'brief',
        notes: [
          `Replace every ${SECRET} with the shared secret from your vault. It must match what the controller is configured with on the RADIUS server.`,
          'Add the controller as a network device on ISE first, or every authentication fails with a silent reject.',
          ...(coa ? ['CoA needs the RADIUS server to reach the controller on UDP 1700. Check the firewall between them.'] : []),
        ],
        before: ['show aaa servers', 'show run aaa', 'show wireless client summary'],
        config: [
          'aaa new-model',
          ...servers.flatMap((server, i) => [
            `radius server RADIUS-${i + 1}`,
            ` address ipv4 ${server} auth-port 1812 acct-port 1813`,
            ` key 0 ${SECRET}`,
            ' timeout 5',
            ' retransmit 3',
            ' automate-tester username probe-user probe-on',
            '!',
          ]),
          `aaa group server radius ${group}`,
          ...servers.map((_, i) => ` server name RADIUS-${i + 1}`),
          ` ip radius source-interface ${str(values, 'source_interface', '')}`,
          ' deadtime 5',
          '!',
          `aaa authentication dot1x ${group} group ${group}`,
          `aaa authorization network ${group} group ${group}`,
          ...(bool(values, 'accounting', true) ? [`aaa accounting identity ${group} start-stop group ${group}`] : []),
          ...(coa ? ['aaa server radius dynamic-author', ...servers.map((server) => ` client ${server} server-key 0 ${SECRET}`), ' auth-type any', '!'] : []),
          `radius-server dead-criteria time ${num(values, 'dead_criteria', 10)} tries 3`,
          'radius-server deadtime 5',
          '!',
        ],
        verify: ['show aaa servers | include RADIUS|state', 'test aaa group ' + group + ' <user> <password> new-code', 'show wireless client summary', 'show wireless stats client detail'],
        backout: [`no aaa group server radius ${group}`, ...servers.map((_, i) => `no radius server RADIUS-${i + 1}`), ...(coa ? ['no aaa server radius dynamic-author'] : [])],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_flexconnect',
    platform: PLATFORM,
    label: 'FlexConnect for a branch',
    group: 'Tags and profiles',
    description: 'A FlexConnect profile with local switching, the VLAN mapping the APs use at the branch, and what happens when the WAN to the controller drops.',
    inputs: [
      { id: 'profile_name', label: 'Flex profile name', control: 'text', default: 'FLEX-BRANCH-01' },
      { id: 'native_vlan', label: 'AP native VLAN', control: 'number', default: 1, min: 1, max: 4094 },
      { id: 'vlan_mappings', label: 'WLAN to local VLAN', control: 'textarea', default: 'WLAN-CORP 20\nWLAN-GUEST 100', hint: 'One per line: WLAN-profile VLAN' },
      { id: 'local_auth', label: 'Local authentication when the WAN drops', control: 'toggle', default: true },
      { id: 'local_dhcp', label: 'Local DHCP', control: 'toggle', default: true },
      { id: 'site_tag', label: 'Site tag to attach it to', control: 'text', default: 'ST-BRANCH-01' },
    ],
    change: (values                 )               => {
      const name = str(values, 'profile_name', 'FLEX').toUpperCase().replace(/\s+/g, '-');
      const mappings = str(values, 'vlan_mappings', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2);
      const siteTag = str(values, 'site_tag', 'ST').toUpperCase().replace(/\s+/g, '-');
      const findings            = [];
      if (mappings.length === 0) {
        findings.push(error('network.wlc.no-flex-mappings', 'FlexConnect with no VLAN mapping leaves clients on the AP native VLAN, which is almost never right.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `FlexConnect profile ${name}`,
        impact: 'outage',
        notes: [
          'Switching a site from central to local switching moves client traffic from the controller to the branch switch. Every VLAN in the mapping has to exist on the AP’s switch port, trunked, or clients associate and go nowhere.',
          'The APs reboot when the site tag changes. Do a branch at a time.',
          'Local authentication only works for the clients whose credentials the AP can cache or check locally — plan for what happens to the rest when the WAN is down.',
        ],
        before: ['show wireless profile flex summary', `show wireless profile flex detailed ${name}`, 'show ap summary', 'show wireless tag site detailed ' + siteTag],
        config: [
          `wireless profile flex ${name}`,
          ' description',
          ` native-vlan-id ${num(values, 'native_vlan', 1)}`,
          ...mappings.flatMap((parts) => [` vlan-name VLAN${parts[1]}`, `  vlan-id ${parts[1]}`]),
          ...(bool(values, 'local_auth', true) ? [' local-auth radius-server-group default'] : []),
          ...(bool(values, 'local_dhcp', true) ? [] : [' ! central DHCP: clients get addresses from the controller side']),
          ' arp-caching',
          '!',
          `wireless tag site ${siteTag}`,
          ` flex-profile ${name}`,
          ' no local-site',
          '!',
          ...mappings.flatMap((parts) => [`wireless profile policy ${parts[0]}-POLICY`, '  no central switching', '  no central dhcp', '  no central association', '!']),
        ],
        verify: [`show wireless profile flex detailed ${name}`, 'show ap summary', 'show wireless client summary', 'Check a client at the branch gets an address from the branch DHCP scope.'],
        backout: [`wireless tag site ${siteTag}`, ' local-site', ' no flex-profile ' + name, '!', `no wireless profile flex ${name}`],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_management_baseline',
    platform: PLATFORM,
    label: 'Controller baseline',
    group: 'Baseline',
    description: 'The country code, the wireless management interface, NTP, syslog, SNMPv3 and the AP certificate settings a controller needs before any AP joins.',
    inputs: [
      { id: 'hostname', label: 'Hostname', control: 'text', default: 'wlc-01' },
      { id: 'country', label: 'Country code', control: 'text', default: 'GB', hint: 'Sets the legal channels and power. Wrong here is a regulatory problem' },
      { id: 'management_vlan', label: 'Wireless management VLAN', control: 'number', default: 10, min: 1, max: 4094 },
      { id: 'management_address', label: 'Management address', control: 'text', default: '10.0.10.5/24' },
      { id: 'ntp_servers', label: 'NTP servers', control: 'text', default: '10.0.0.10, 10.0.0.11', hint: 'APs will not join a controller whose clock is wrong' },
      { id: 'syslog_server', label: 'Syslog server', control: 'text', default: '10.0.0.20' },
      { id: 'snmp_user', label: 'SNMPv3 user', control: 'text', default: 'monitor' },
      { id: 'netconf', label: 'Enable NETCONF for automation', control: 'toggle', default: true },
    ],
    change: (values                 )               => {
      const country = str(values, 'country', 'GB').toUpperCase();
      const vlan = num(values, 'management_vlan', 10);
      const cidr = parseCidr(str(values, 'management_address', ''));
      const ntp = listOf(str(values, 'ntp_servers', ''));
      const findings            = [];
      if (country.length !== 2) {
        findings.push(error('network.wlc.country-code', 'The country code must be the two-letter code for where the APs are. It decides the legal channels and power.', { source: 'ArchToolKit' }));
      }

      return {
        platform: PLATFORM,
        title: `Controller baseline for ${str(values, 'hostname', 'wlc')}`,
        impact: 'outage',
        notes: [
          '**Changing the country code disables every radio until it is re-applied.** It is a maintenance-window change on a live controller.',
          'The clock matters more here than anywhere: an AP will not join a controller whose certificate looks invalid because the time is wrong.',
          `Replace every ${SECRET} with the real credential from your vault.`,
        ],
        before: ['show wireless management interface', 'show wireless country configured', 'show ap summary', 'show ntp status'],
        config: [
          `hostname ${str(values, 'hostname', 'wlc-01')}`,
          `ap dot11 24ghz shutdown`,
          `ap dot11 5ghz shutdown`,
          `wireless country ${country}`,
          `no ap dot11 24ghz shutdown`,
          `no ap dot11 5ghz shutdown`,
          '!',
          `interface Vlan${vlan}`,
          ' description Wireless management',
          ...(cidr ? [` ip address ${cidr.address} ${netmask(cidr.prefix)}`] : []),
          ' no shutdown',
          '!',
          `wireless management interface Vlan${vlan}`,
          '!',
          ...ntp.map((server) => `ntp server ${server}`),
          `logging host ${str(values, 'syslog_server', '')}`,
          'logging trap informational',
          'service timestamps log datetime msec localtime show-timezone',
          '!',
          'snmp-server group MONITOR v3 priv',
          `snmp-server user ${str(values, 'snmp_user', 'monitor')} MONITOR v3 auth sha ${SECRET} priv aes 128 ${SECRET}`,
          '!',
          ...(bool(values, 'netconf', true) ? ['netconf-yang'] : []),
        ],
        verify: ['show wireless management interface', 'show wireless country configured', 'show ntp status', 'show ap summary', 'show logging | include Logging to'],
        backout: [`no wireless management interface Vlan${vlan}`, ...ntp.map((server) => `no ntp server ${server}`), `no logging host ${str(values, 'syslog_server', '')}`, ...(bool(values, 'netconf', true) ? ['no netconf-yang'] : [])],
        findings,
      };
    },
  }),

  deviceBlueprint({
    id: 'wlc_mobility',
    platform: PLATFORM,
    label: 'Mobility group and guest anchor',
    group: 'Baseline',
    description: 'Mobility peers so clients roam between controllers, and an anchor controller for guest traffic that terminates in a DMZ.',
    inputs: [
      { id: 'group_name', label: 'Mobility group', control: 'text', default: 'CAMPUS' },
      { id: 'local_address', label: 'This controller’s mobility address', control: 'text', default: '10.0.10.5' },
      { id: 'peers', label: 'Peers', control: 'textarea', default: '10.0.20.5 CAMPUS aabb.ccdd.eeff', hint: 'One per line: address group mac-address' },
      { id: 'anchor', label: 'Guest anchor', control: 'text', default: '', hint: 'The DMZ controller’s mobility address; empty for none' },
      { id: 'anchor_policy', label: 'Policy profile to anchor', control: 'text', default: 'PP-GUEST', showWhen: { input: 'anchor', notEquals: [''] } },
    ],
    change: (values                 )               => {
      const group = str(values, 'group_name', 'CAMPUS').toUpperCase();
      const peers = str(values, 'peers', '')
        .split(/\n+/)
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2);
      const anchor = str(values, 'anchor', '');
      const policy = str(values, 'anchor_policy', 'PP-GUEST');

      return {
        platform: PLATFORM,
        title: `Mobility group ${group}${anchor ? ` with a guest anchor` : ''}`,
        impact: 'brief',
        notes: [
          'Every controller in the group needs the same group name and each other as peers, with matching MAC addresses. A one-sided peering shows as a tunnel that never comes up.',
          ...(anchor ? ['Guest anchoring tunnels guest traffic to the DMZ controller. Both ends need the same WLAN profile name and the same security settings, or clients associate and are dropped.'] : []),
          'Mobility tunnels use UDP 16666 and 16667. Check the path between the controllers permits them.',
        ],
        before: ['show wireless mobility summary', 'show wireless mobility peer ip <peer>', 'show wireless client summary'],
        config: [
          `wireless mobility group name ${group}`,
          ...peers.map((parts) => `wireless mobility group member ip ${parts[0]} group ${parts[1] ?? group}${parts[2] ? ` public-ip ${parts[0]}` : ''}`),
          '!',
          ...(anchor ? [`wireless profile policy ${policy}`, `  mobility anchor ${anchor} priority 1`, '!'] : []),
        ],
        verify: ['show wireless mobility summary', 'show wireless mobility peer ip ' + (peers[0]?.[0] ?? '<peer>'), ...(anchor ? [`show wireless profile policy detailed ${policy}`, 'show wireless client summary anchor'] : [])],
        backout: [
          ...(anchor ? [`wireless profile policy ${policy}`, `  no mobility anchor ${anchor}`, '!'] : []),
          ...peers.map((parts) => `no wireless mobility group member ip ${parts[0]}`),
        ],
      };
    },
  }),
];

export const WLC_NETWORK                 = { target: PLATFORM, label: 'Cisco Catalyst 9800 (wireless)', blueprints: BLUEPRINTS };
export const WLC_CHANGES                             = BLUEPRINTS;

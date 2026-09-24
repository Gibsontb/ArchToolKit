/**
 * Syntax modes CodeMirror does not ship, for the files network and platform
 * engineers actually open: Cisco IOS / NX-OS / Arista EOS configs, Junos,
 * Splunk .conf and INI, Terraform/HCL, and log files.
 *
 * They are CodeMirror "stream parsers": a tokenizer over one line at a time
 * with a small state object. They are plain objects here (no CodeMirror
 * import) and languages.ts wraps them with StreamLanguage.define, so the
 * tokenizers can be tested with the real StringStream.
 *
 * Token names are CodeMirror's legacy style names; each maps to a highlight
 * tag of the same name (keyword, comment, string, number, atom, typeName,
 * propertyName, variableName, heading, meta, invalid, annotation, operator).
 */

/** The parts of CodeMirror's StringStream these tokenizers use. */
                         
                 
                 
                             
                        
                                             
                                            
                      
                    
                                     
                                                                                                                   
                    
                        
                   
                          
                       
                          
 

                          
                        
                  
                                                 
                          
                                                  
 

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?\b/;
// Needs two colons or "::" so "10:20" (a time, a VLAN range) is not an address.
const IPV6 = /^(?:[0-9a-fA-F]{0,4}:){2,6}\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,3})?|^(?=[0-9a-fA-F]*:[0-9a-fA-F]*:)(?:[0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}(?:\/\d{1,3})?(?![\w:.])/;
const MAC = /^(?:[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}|[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})\b/;

/** Addresses and numbers every network mode highlights the same way. */
function matchAddress(stream        )                {
  if (stream.match(MAC)) return 'number';
  if (stream.match(IPV4)) return 'number';
  if (stream.match(IPV6)) return 'number';
  return null;
}

// ---- Cisco IOS / NX-OS / Arista EOS -------------------------------------

const CISCO_BLOCKS = new Set([
  'interface', 'router', 'line', 'vlan', 'vrf', 'route-map', 'class-map', 'policy-map', 'ip', 'ipv6', 'crypto', 'object-group',
  'control-plane', 'aaa', 'banner', 'key', 'track', 'monitor', 'spanning-tree', 'snmp-server', 'logging', 'ntp', 'username',
  'hostname', 'feature', 'boot', 'version', 'service', 'clock', 'management', 'archive', 'event', 'redundancy', 'license',
  'port-channel', 'vpc', 'mac', 'errdisable', 'lldp', 'cdp', 'tacacs-server', 'radius-server', 'tacacs', 'radius', 'address-family',
  'end', 'exit', 'exit-address-family', 'daemon', 'mlag', 'dhcp', 'system', 'transceiver', 'queue-monitor', 'hardware', 'platform',
  'access-list', 'prefix-list', 'enable', 'dot1x', 'multilink', 'zone', 'zone-pair', 'parameter-map', 'template', 'nat',
]);

const CISCO_KEYWORDS = new Set([
  'description', 'shutdown', 'switchport', 'mode', 'access', 'trunk', 'allowed', 'native', 'channel-group', 'active', 'passive',
  'on', 'address', 'secondary', 'standby', 'vrrp', 'hsrp', 'priority', 'preempt', 'network', 'neighbor', 'remote-as', 'update-source',
  'route-reflector-client', 'next-hop-self', 'send-community', 'redistribute', 'area', 'passive-interface', 'default-information',
  'originate', 'match', 'set', 'permit', 'deny', 'remark', 'any', 'host', 'eq', 'gt', 'lt', 'range', 'established', 'log', 'tcp',
  'udp', 'icmp', 'ip', 'ipv6', 'helper-address', 'mtu', 'speed', 'duplex', 'auto', 'full', 'half', 'encapsulation', 'dot1q',
  'nameif', 'security-level', 'transport', 'input', 'output', 'ssh', 'telnet', 'login', 'local', 'password', 'secret', 'privilege',
  'exec-timeout', 'access-class', 'in', 'out', 'bandwidth', 'delay', 'ospf', 'bgp', 'eigrp', 'isis', 'rip', 'static', 'connected',
  'router-id', 'timers', 'authentication', 'message-digest', 'cost', 'vrf', 'forwarding', 'rd', 'route-target', 'import', 'export',
  'both', 'unicast', 'multicast', 'family', 'portfast', 'bpduguard', 'bpdufilter', 'guard', 'root', 'loop', 'storm-control',
  'service-policy', 'police', 'class', 'default', 'peer-link', 'peer-keepalive', 'domain', 'role', 'source', 'destination',
  'group', 'version', 'community', 'ro', 'rw', 'server', 'trap', 'traps', 'buffered', 'console', 'monitor', 'level', 'enable',
  'no', 'autostate', 'fabric', 'mlag', 'peer-address', 'peer-group', 'maximum-paths', 'ecmp', 'lacp', 'rate', 'fast', 'normal',
]);

const CISCO_PERMIT = new Set(['permit', 'active', 'on', 'full', 'auto']);
const CISCO_DENY = new Set(['deny', 'shutdown']);

const IFACE = /^(?:(?:Fast|Gigabit|TenGigabit|TwentyFiveGig|FortyGigabit|HundredGig|FourHundredGig|TwoGigabit|FiveGigabit|Ten|Forty|Hundred)?(?:Ethernet|E|Gi|Te|Fa|Fo|Hu|Tw|TenGigE|TwentyFiveGigE|HundredGigE|FortyGigE)|Ethernet|Eth|Et|Management|Ma|mgmt|Vlan|Vl|Loopback|Lo|Port-channel|Po|port-channel|Tunnel|Tu|Serial|Se|BVI|Nve|nve|Vxlan|Dialer|Virtual-Template|Bundle-Ether|MgmtEth|Null|Cellular|Recirc-Iface)\d[\d/.:]*\b/i;

                             
                 
                                        
                           
 

export const ciscoMode                   = {
  name: 'cisco',
  startState: () => ({ first: true, rest: null, bannerEnd: null }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.bannerEnd) {
      // Everything up to the delimiter is the banner's text, across lines.
      const at = stream.string.indexOf(state.bannerEnd, stream.pos);
      if (at < 0) {
        stream.skipToEnd();
        return 'string';
      }
      while (stream.pos < at) stream.next();
      stream.next();
      state.bannerEnd = null;
      return 'string';
    }
    if (stream.sol()) {
      state.first = true;
      state.rest = null;
    }
    if (stream.eatSpace()) return null;
    if (state.first && stream.match(/^!.*/)) return 'comment';
    // NX-OS and EOS also accept "#" comment lines in saved configs.
    if (state.first && stream.match(/^#.*/)) return 'comment';
    if (state.rest === 'description') {
      stream.skipToEnd();
      return 'string';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    const address = matchAddress(stream);
    if (address) return address;
    if (stream.match(IFACE)) {
      state.first = false;
      return 'typeName';
    }
    if (stream.match(/^\d+(?:[-,]\d+)*\b/)) {
      state.first = false;
      return 'number';
    }
    const word = stream.match(/^[A-Za-z][\w.-]*/)                           ;
    if (word) {
      const w = word[0].toLowerCase();
      const wasFirst = state.first;
      state.first = false;
      if (w === 'description' || w === 'remark' || w === 'alias') {
        state.rest = 'description';
        return 'keyword';
      }
      if (w === 'banner') {
        // "banner motd ^C ... ^C" — find the delimiter after the banner type.
        const m = /^\s+\S+\s+(\S)/.exec(stream.string.slice(stream.pos));
        if (m) {
          const delim = m[1] === '^' && stream.string.slice(stream.pos).includes('^C') ? '^C' : m[1] ;
          while (stream.string.slice(stream.pos, stream.pos + delim.length) !== delim && !stream.eol()) stream.next();
          for (let i = 0; i < delim.length; i++) stream.next();
          const close = stream.string.indexOf(delim, stream.pos);
          if (close < 0) state.bannerEnd = delim;
          else while (stream.pos < close + delim.length) stream.next();
        }
        return 'keyword';
      }
      // Only an unindented block keyword opens a section ("interface" under "router" is a setting).
      if (wasFirst && stream.column() === 0 && CISCO_BLOCKS.has(w)) return 'heading';
      if (w === 'no' && wasFirst) return 'operator';
      if (CISCO_DENY.has(w)) return 'invalid';
      if (CISCO_PERMIT.has(w)) return 'atom';
      if (CISCO_BLOCKS.has(w) || CISCO_KEYWORDS.has(w)) return 'keyword';
      return null;
    }
    stream.next();
    state.first = false;
    return null;
  },
  languageData: { commentTokens: { line: '!' } },
};

// ---- Junos --------------------------------------------------------------

const JUNOS_KEYWORDS = new Set([
  'system', 'interfaces', 'protocols', 'routing-options', 'policy-options', 'firewall', 'security', 'chassis', 'snmp', 'vlans',
  'routing-instances', 'class-of-service', 'forwarding-options', 'services', 'applications', 'groups', 'apply-groups', 'unit',
  'family', 'inet', 'inet6', 'ethernet-switching', 'mpls', 'iso', 'address', 'host-name', 'domain-name', 'name-server', 'ntp',
  'server', 'syslog', 'login', 'user', 'class', 'authentication', 'root-authentication', 'encrypted-password', 'ssh-rsa',
  'ospf', 'ospf3', 'bgp', 'isis', 'ldp', 'rsvp', 'lldp', 'rstp', 'mstp', 'vstp', 'area', 'interface', 'group', 'type',
  'internal', 'external', 'neighbor', 'peer-as', 'local-as', 'local-address', 'export', 'import', 'policy-statement', 'term',
  'from', 'then', 'prefix-list', 'route-filter', 'exact', 'orlonger', 'longer', 'upto', 'prefix-length-range', 'community',
  'members', 'static', 'route', 'next-hop', 'router-id', 'autonomous-system', 'filter', 'input', 'output', 'protocol',
  'source-address', 'destination-address', 'source-port', 'destination-port', 'port', 'count', 'policer', 'description',
  'vlan-id', 'vlan-tagging', 'native-vlan-id', 'interface-mode', 'trunk', 'access', 'aggregated-ether-options', 'lacp',
  'ether-options', 'gigether-options', '802.3ad', 'mtu', 'zones', 'security-zone', 'policies', 'policy', 'match', 'nat',
  'set', 'delete', 'deactivate', 'activate', 'edit', 'top', 'up', 'annotate', 'inactive:', 'replace:', 'version',
]);

                             
                          
 

export const junosMode                   = {
  name: 'junos',
  startState: () => ({ inBlockComment: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.match(/^.*?\*\//)) state.inBlockComment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('/*')) {
      if (!stream.match(/^.*?\*\//)) {
        stream.skipToEnd();
        state.inBlockComment = true;
      }
      return 'comment';
    }
    if (stream.match(/^#.*/)) return 'comment';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^[{}]/)) return 'bracket';
    if (stream.match(/^[;[\]]/)) return 'punctuation';
    const address = matchAddress(stream);
    if (address) return address;
    if (stream.match(/^(?:ge|xe|et|fe|ae|lo|irb|vlan|em|fxp|me|reth|st|gr|ip|lt|vme|ms|sp|so|mge|ce)-?\d+(?:\/\d+)*(?:\.\d+)?\b/)) return 'typeName';
    if (stream.match(/^\d+(?:\.\d+)?[kmg]?\b/i)) return 'number';
    const word = stream.match(/^[A-Za-z][\w:.-]*/)                           ;
    if (word) {
      const w = word[0];
      if (w === 'accept' || w === 'permit') return 'atom';
      if (w === 'reject' || w === 'discard' || w === 'deny' || w === 'disable' || w === 'inactive:') return 'invalid';
      if (w === 'set' || w === 'delete' || w === 'deactivate' || w === 'activate') return 'operator';
      if (JUNOS_KEYWORDS.has(w)) return stream.string.slice(stream.pos).trimStart().startsWith('{') ? 'heading' : 'keyword';
      return stream.string.slice(stream.pos).trimStart().startsWith('{') ? 'heading' : null;
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#', block: { open: '/*', close: '*/' } } },
};

// ---- INI and Splunk .conf -----------------------------------------------

                           
                   
                                                                                                     
                     
 

export const iniMode                 = {
  name: 'ini',
  startState: () => ({ inValue: false, continues: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (stream.sol()) {
      state.inValue = state.continues;
      state.continues = /\\\s*$/.test(stream.string);
    }
    if (stream.sol() && !state.inValue) {
      stream.eatSpace();
      if (stream.match(/^[#;].*/)) return 'comment';
      if (stream.match(/^\[[^\]]*\]?/)) return 'heading';
    }
    if (stream.eatSpace()) return null;
    if (!state.inValue) {
      if (stream.match(/^[^=:\s][^=]*?(?=\s*[=:])/)) return 'propertyName';
      if (stream.match(/^[=:]/)) {
        state.inValue = true;
        return 'operator';
      }
      stream.skipToEnd();
      return null;
    }
    if (stream.match(/^\$[\w.:]+\$/)) return 'variableName';
    if (stream.match(/^%[\w.:]+%/)) return 'variableName';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^(?:true|false|yes|no|on|off|enabled?|disabled?|none|null|t|f)\b(?![\w.-])/i)) return 'atom';
    const address = matchAddress(stream);
    if (address) return address;
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[smhdwkKMGT]|ms|mb|gb|kb)?\b(?![\w.])/)) return 'number';
    if (stream.match(/^[\w./\\-]+/)) return 'string';
    stream.next();
    return 'string';
  },
  languageData: { commentTokens: { line: '#' } },
};

// ---- Terraform / HCL ----------------------------------------------------

const HCL_BLOCKS = new Set(['resource', 'data', 'module', 'variable', 'output', 'provider', 'terraform', 'locals', 'moved', 'import', 'check', 'removed', 'backend', 'required_providers', 'dynamic', 'lifecycle', 'provisioner', 'connection', 'content', 'validation', 'precondition', 'postcondition', 'cloud', 'job', 'group', 'task']);
const HCL_KEYWORDS = new Set(['for', 'in', 'if', 'for_each', 'count', 'depends_on', 'source', 'version', 'each', 'var', 'local', 'self', 'path', 'count.index', 'endfor', 'endif', 'else']);

                           
                         
                        
                                                                                             
 

export const hclMode                 = {
  name: 'hcl',
  startState: () => ({ heredoc: null, blockComment: false }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.heredoc) {
      if (stream.sol() && stream.match(new RegExp(`^\\s*${state.heredoc}\\s*$`))) {
        state.heredoc = null;
        return 'string';
      }
      stream.skipToEnd();
      return 'string';
    }
    if (state.blockComment) {
      if (stream.match(/^.*?\*\//)) state.blockComment = false;
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^(?:#|\/\/).*/)) return 'comment';
    if (stream.match('/*')) {
      if (!stream.match(/^.*?\*\//)) {
        stream.skipToEnd();
        state.blockComment = true;
      }
      return 'comment';
    }
    const heredoc = stream.match(/^<<-?\s*([A-Za-z_]\w*)/)                           ;
    if (heredoc) {
      state.heredoc = heredoc[1] ;
      return 'string';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^(?:true|false|null)\b/)) return 'atom';
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b/)) return 'number';
    const word = stream.match(/^[A-Za-z_][\w-]*/)                           ;
    if (word) {
      const w = word[0];
      const rest = stream.string.slice(stream.pos);
      if (HCL_BLOCKS.has(w) && /^\s*(?:"|\{|[A-Za-z_])/.test(rest) && !/^\s*=/.test(rest)) return 'keyword';
      if (HCL_KEYWORDS.has(w)) return 'keyword';
      if (/^\s*=(?!=)/.test(rest)) return 'propertyName';
      if (/^\s*\(/.test(rest)) return 'variableName function';
      return 'variableName';
    }
    if (stream.match(/^(?:==|!=|<=|>=|&&|\|\||=>|[=+\-*/%<>!?:])/)) return 'operator';
    if (stream.match(/^[{}[\]()]/)) return 'bracket';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#', block: { open: '/*', close: '*/' } } },
};

// ---- Log files ----------------------------------------------------------

const TIMESTAMP =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|[A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}(?:\.\d+)?|\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?|\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}(?:[.,]\d+)?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)/;

export const logMode                              = {
  name: 'log',
  startState: () => ({}),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(TIMESTAMP)) return 'meta';
    if (stream.match(/^(?:FATAL|CRITICAL|CRIT|EMERG(?:ENCY)?|ALERT|SEVERE|ERROR|ERR|FAIL(?:ED|URE)?|EXCEPTION|PANIC)\b/i)) return 'invalid';
    if (stream.match(/^(?:WARN(?:ING)?|W)\b(?=[\]:\s])/i) || stream.match(/^WARN(?:ING)?\b/i)) return 'annotation';
    if (stream.match(/^(?:INFO|NOTICE|I)\b(?=[\]:\s])/) || stream.match(/^(?:INFO|NOTICE)\b/i)) return 'labelName';
    if (stream.match(/^(?:DEBUG|TRACE|VERBOSE|FINE|FINER|FINEST)\b/i)) return 'comment';
    if (stream.match(/^\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)) return 'number';
    const address = matchAddress(stream);
    if (address) return address;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(/^[\w.-]+(?==)/)) return 'propertyName';
    if (stream.match(/^\b0x[0-9a-f]+\b/i) || stream.match(/^-?\d+(?:\.\d+)?(?:ms|s|%|[kKMG]B?)?\b/)) return 'number';
    if (stream.match(/^(?:https?|ftp|file):\/\/\S+/)) return 'link';
    if (stream.match(/^\[[^\]]*\]/)) return 'bracket';
    if (stream.match(/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)+(?:Exception|Error)\b/)) return 'invalid';
    if (stream.match(/^\w+/)) return null;
    stream.next();
    return null;
  },
};

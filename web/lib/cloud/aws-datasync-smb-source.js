import { bool,                      } from '../kit/blueprint.js';
import { awsServicePartition } from './aws-service-module.js';
/** Shared bounded NTLM/SMB3 source metadata; never consumes a password. */
export function awsDataSyncSmbSource(values                 , reject                                   ) {
  const region=String(values.aws_region ?? ''), partition=awsServicePartition(region), name=String(values.name ?? '').trim(), agent=String(values.agent ?? '').trim(), server=String(values.server ?? '').trim(), path=String(values.path ?? '').trim(), user=String(values.user ?? '').trim(), domain=String(values.domain ?? '').trim();
  const match=/^arn:([^:]+):datasync:([^:]+):(\d{12}):agent\/agent-[0-9a-f]{17}$/.exec(agent), account=match?.[3] ?? '';
  if (!match || match[1]!==partition || match[2]!==region) reject('agent','Use an activated Basic-mode agent in the selected region/partition.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,119}$/.test(name)) reject('name','Use 2–120 letters, numbers, dots, underscores or hyphens.');
  if (server.length>253 || !server.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(server) && server.split('.').some(value=>Number(value)>255)) reject('server','Use the underlying SMB hostname or valid IPv4 address.');
  if (!/^\/[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/.test(path) || path.split('/').some(part=>part==='.' || part==='..') || path.length>4096) reject('path','Use /share or /share/directory without server prefix, traversal or trailing slash. This guided path supports letters, digits, _, $, dot and hyphen.');
  if (!/^[A-Za-z0-9_.@-]{1,104}$/.test(user)) reject('user','Use the source username only, without domain separator/password.');
  if (domain && (domain.length>253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain) || domain.includes('..'))) reject('domain','Enter the domain name or leave blank for an approved local account.');
  if (!bool(values,'ntlm_allowed')) reject('ntlm_allowed','Confirm the applicable policy permits NTLM; otherwise use a qualified Kerberos workflow.');
  return {region,partition,name,agent,server,path,user,domain,account};
}

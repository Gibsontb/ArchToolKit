/**
 * Oracle Cloud: IAM policies, as the console, the CLI (`oci iam policy get`)
 * and Resource Manager hold them — a name, a compartment and a list of
 * statements in OCI's policy language.
 *
 * Each statement is parsed against the grammar:
 *
 *   Allow <subject> to <verb> <resource-type> in <location> [where <conditions>]
 *   Allow <subject> to {PERMISSION, …} in <location> [where …]
 *
 * with the subject a group, dynamic-group, any-user, any-group or service.
 * Endorse, Admit and Define (cross-tenancy) statements are recognised and left
 * alone. A statement OCI would refuse is an error; one that grants more than
 * it probably means to is a warning.
 */

import { error, info, warning,              } from '../../core/findings.js';
import { pathString,           } from '../doc.js';
import { isObj, str,              } from '../profile.js';

const SOURCE = 'OCI policy syntax (docs.oracle.com/iaas/Content/Identity/Concepts/policysyntax.htm)';

export const VERBS = ['inspect', 'read', 'use', 'manage']         ;

/** The aggregate resource types; individual types are too many to list and are checked by shape. */
export const FAMILIES = [
  'all-resources', 'cluster-family', 'compute-management-family', 'data-catalog-family', 'database-family',
  'dns', 'file-family', 'instance-agent-command-family', 'instance-agent-family', 'instance-family', 'object-family',
  'virtual-network-family', 'volume-family', 'autonomous-database-family', 'cloud-guard-family', 'vaults', 'keys',
  'secret-family', 'logging-family', 'metrics', 'alarms', 'ons-family', 'functions-family', 'repos', 'tag-namespaces',
  'tenancies', 'users', 'groups', 'dynamic-groups', 'policies', 'compartments', 'domains',
];

                                  
                                                                    
                            
                         
                                           
                             
                             
                          
 

/** Parse one statement, or say what is wrong with it. */
export function parseStatement(text        )                                              {
  const s = text.trim().replace(/\s+/g, ' ');
  const head = s.split(' ')[0]?.toLowerCase();
  if (head === 'endorse' || head === 'admit' || head === 'define') return { ok: { kind: head } };
  if (head !== 'allow') return { error: 'A statement starts with Allow (or Endorse, Admit or Define for cross-tenancy access).' };
  const m = /^allow (.+?) to (.+?) in (tenancy|compartment (?:id )?[^\s]+)(?: where (.+))?$/i.exec(s);
  if (!m) {
    if (!/ to /i.test(s)) return { error: 'The statement has no “to”: Allow <subject> to <verb> <resource-type> in <location>.' };
    if (!/ in (tenancy|compartment )/i.test(s)) return { error: 'The statement has no location: end it with “in tenancy” or “in compartment <name>”.' };
    return { error: 'The statement does not follow Allow <subject> to <verb> <resource-type> in <location> [where …].' };
  }
  const [, subject, what, location, where] = m                                                                   ;
  const subj = subject.trim();
  if (!/^(any-user|any-group|(group|dynamic-group) (id )?.+|service .+|resource .+)$/i.test(subj)) {
    return { error: `“${subj}” is not a subject; it is group, dynamic-group, any-user, any-group or service, followed by names.` };
  }
  const perms = /^\{(.+)\}$/.exec(what.trim());
  if (perms) {
    const list = (perms[1]          ).split(',').map((p) => p.trim()).filter(Boolean);
    const bad = list.find((p) => !/^[A-Z][A-Z0-9_]+$/.test(p));
    if (bad) return { error: `${bad} is not a permission name; permissions are written in capitals, as INSTANCE_READ.` };
    return { ok: { kind: 'allow', subject: subj, permissions: list, location, where } };
  }
  const [verb, resource, ...extra] = what.trim().split(' ');
  if (!verb || !VERBS.includes(verb.toLowerCase()                          )) {
    return { error: `“${verb ?? ''}” is not a verb; OCI has inspect, read, use and manage.` };
  }
  if (!resource) return { error: 'The statement names no resource type.' };
  if (extra.length) return { error: `“${extra.join(' ')}” after ${resource} is not understood; one resource type per statement.` };
  if (!/^[a-z][a-z0-9-]*$/.test(resource)) return { error: `${resource} is not a resource type; they are lower-case with hyphens, as instance-family.` };
  return { ok: { kind: 'allow', subject: subj, verb: verb.toLowerCase(), resource, location, where } };
}

function statementsOf(doc      )                                                        {
  if (Array.isArray(doc) && doc.length > 0 && doc.every((s) => typeof s === 'string' && /^\s*(allow|endorse|admit|define)\b/i.test(s))) return { list: doc, at: [] };
  if (!isObj(doc)) return undefined;
  for (const key of ['statements', 'Statements']) {
    const v = doc[key];
    if (Array.isArray(v) && v.some((s) => typeof s === 'string' && /^\s*(allow|endorse|admit|define)\b/i.test(s))) return { list: v, at: [key] };
  }
  if (isObj(doc.data)) {
    const inner = statementsOf(doc.data);
    if (inner) return { list: inner.list, at: ['data', ...inner.at] };
  }
  return undefined;
}

export const ociIamPolicy          = {
  id: 'oci-iam-policy',
  family: 'oracle',
  label: 'Oracle Cloud IAM policy',
  format: 'json',
  source: SOURCE,
  detect: (doc) => (statementsOf(doc) ? 0.9 : 0),
  validate(doc) {
    const out            = [];
    const found = statementsOf(doc);
    if (!found) return out;
    if (found.list.length > 50) {
      out.push(warning('oci.policy.limit', `${found.list.length} statements; a policy holds at most 50.`, { path: pathString(found.at), source: 'OCI IAM service limits' }));
    }
    const seen = new Set        ();
    found.list.forEach((s, i) => {
      const path = pathString([...found.at, i]);
      if (typeof s !== 'string') {
        out.push(error('oci.statement.type', 'A statement is a string.', { path }));
        return;
      }
      const norm = s.trim().replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(norm)) out.push(warning('oci.statement.duplicate', 'This statement appears twice.', { path }));
      seen.add(norm);
      const r = parseStatement(s);
      if ('error' in r) {
        out.push(error('oci.statement.syntax', r.error, { path, source: SOURCE }));
        return;
      }
      const st = r.ok;
      if (st.kind !== 'allow') {
        out.push(info('oci.statement.cross-tenancy', 'A cross-tenancy statement; its grammar is not checked here.', { path }));
        return;
      }
      const broad = st.verb === 'manage' && st.resource === 'all-resources';
      if (broad && /^tenancy$/i.test(st.location ?? '')) {
        out.push(warning('oci.statement.admin', `${st.subject} gets full control of every resource in the tenancy.`, { path, remediation: 'Scope it to a compartment, or to the resource families the group runs.' }));
      } else if (broad) {
        out.push(info('oci.statement.compartment-admin', `${st.subject} administers everything in ${st.location}.`, { path }));
      }
      if (/^any-user$/i.test(st.subject ?? '') && !st.where) {
        out.push(warning('oci.statement.any-user', 'any-user with no where clause applies to every user and resource principal in the tenancy.', { path, remediation: 'Add a where clause, such as request.principal.type = …' }));
      }
      if (st.resource && !FAMILIES.includes(st.resource) && st.resource.endsWith('-family')) {
        out.push(warning('oci.statement.family', `${st.resource} is not an aggregate resource type the toolkit knows of.`, { path, source: SOURCE }));
      }
    });
    if (isObj(doc) && found.at[0] === 'statements' && !str(doc.description) && 'name' in doc) {
      out.push(info('oci.policy.description', 'OCI requires a description when the policy is created.', { path: 'description' }));
    }
    return out;
  },
  itemTitle: (value) => (isObj(value) ? str(value.name) : undefined),
};

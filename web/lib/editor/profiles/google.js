/**
 * Google Cloud: IAM allow policies (the JSON or YAML `gcloud … get-iam-policy`
 * returns and `set-iam-policy` takes) and Deployment Manager configurations.
 *
 * GKE manifests are Kubernetes, and Terraform for Google is Terraform; both
 * have their own profiles.
 */

import { error, warning,              } from '../../core/findings.js';
import { pathString,                      } from '../doc.js';
import { isObj, last, str,              } from '../profile.js';

const IAM_SOURCE = 'Google Cloud IAM policy reference (cloud.google.com/iam/docs/reference/rest/v1/Policy)';
const DM_SOURCE = 'Deployment Manager deprecation (cloud.google.com/deployment-manager/docs/deprecations)';

const MEMBER = /^(user|serviceAccount|group|domain|deleted:user|deleted:serviceAccount|deleted:group):.+$|^(allUsers|allAuthenticatedUsers)$|^principal(Set)?:\/\/.+$|^projectOwner:|^projectEditor:|^projectViewer:/;
const ROLE = /^(roles\/[A-Za-z0-9_.]+|projects\/[^/]+\/roles\/[A-Za-z0-9_.]+|organizations\/\d+\/roles\/[A-Za-z0-9_.]+)$/;

function isIamPolicy(doc      )                              {
  return isObj(doc) && Array.isArray(doc.bindings) && doc.bindings.every((b) => isObj(b) && ('role' in b || 'members' in b));
}

export const googleIamPolicy          = {
  id: 'google-iam-policy',
  family: 'google',
  label: 'Google Cloud IAM policy',
  format: 'json',
  source: IAM_SOURCE,
  detect: (doc) => (isIamPolicy(doc) ? 0.9 : 0),
  choices(path      ) {
    const key = last(path);
    if (key === 'version' && path.length === 1) return ['1', '3'];
    if (key === 'logType') return ['ADMIN_READ', 'DATA_READ', 'DATA_WRITE'];
    return undefined;
  },
  validate(doc) {
    const out            = [];
    if (!isIamPolicy(doc)) return out;
    let conditional = false;
    const seen = new Map                ();
    (doc.bindings          ).forEach((b, i) => {
      if (!isObj(b)) return;
      const role = str(b.role);
      if (!role) out.push(error('gcp.iam.role.missing', 'A binding needs a role.', { path: pathString(['bindings', i]), source: IAM_SOURCE }));
      else if (!ROLE.test(role)) {
        out.push(error('gcp.iam.role.format', `${role} is not a role name; roles are written roles/…, projects/ID/roles/… or organizations/ID/roles/….`, { path: pathString(['bindings', i, 'role']), source: IAM_SOURCE }));
      } else if (/^roles\/(owner|editor)$/.test(role)) {
        out.push(warning('gcp.iam.basic-role', `${role} is a basic role, with access to nearly every service in the project.`, { path: pathString(['bindings', i, 'role']), remediation: 'Grant the predefined roles the member needs instead.' }));
      }
      if (b.condition !== undefined) conditional = true;
      if (role && b.condition === undefined) {
        if (seen.has(role)) out.push(warning('gcp.iam.role.duplicate', `${role} is bound twice without a condition; the members can go in one binding.`, { path: pathString(['bindings', i, 'role']) }));
        seen.set(role, i);
      }
      if (!Array.isArray(b.members) || b.members.length === 0) {
        out.push(error('gcp.iam.members', 'A binding needs at least one member.', { path: pathString(['bindings', i, 'members']), source: IAM_SOURCE }));
        return;
      }
      b.members.forEach((m, mi) => {
        const text = str(m) ?? '';
        const at = pathString(['bindings', i, 'members', mi]);
        if (!MEMBER.test(text)) {
          out.push(error('gcp.iam.member.format', `“${text}” is not a member; members are written user:, serviceAccount:, group:, domain:, principal:// or principalSet://.`, { path: at, source: IAM_SOURCE }));
        } else if (text === 'allUsers' || text === 'allAuthenticatedUsers') {
          out.push(warning('gcp.iam.public', `${text} makes ${role ?? 'this role'} public${text === 'allAuthenticatedUsers' ? ' to any Google account' : ''}.`, { path: at }));
        }
      });
    });
    if (conditional && doc.version !== 3 && doc.version !== '3') {
      out.push(error('gcp.iam.version', 'A policy with conditional bindings must be version 3, or the conditions are dropped.', { path: 'version', source: IAM_SOURCE }));
    }
    return out;
  },
  itemTitle: (value) => (isObj(value) ? str(value.role) ?? str(value.service) : undefined),
};

function isDeploymentManager(doc      )                              {
  return (
    isObj(doc) &&
    Array.isArray(doc.resources) &&
    doc.resources.length > 0 &&
    doc.resources.every((r) => isObj(r) && typeof r.name === 'string' && typeof r.type === 'string' && !('apiVersion' in r)) &&
    doc.resources.some((r) => isObj(r) && /^([a-z]+\.v[0-9a-z]+\.[A-Za-z]+|gcp-types\/.+|.+\.(jinja|py))$/.test(String(r.type)))
  );
}

export const googleDeploymentManager          = {
  id: 'google-deployment-manager',
  family: 'google',
  label: 'Google Deployment Manager configuration (retired)',
  format: 'yaml',
  source: DM_SOURCE,
  detect: (doc) => (isDeploymentManager(doc) ? 0.85 : 0),
  validate(doc) {
    const out            = [
      warning('gcp.dm.deprecated', 'Deployment Manager support ended on 1 April 2026 and the service is turned down after 30 June 2027.', {
        path: '',
        remediation: 'Move to Infrastructure Manager, which deploys Terraform; the toolkit’s Terraform kit writes the configuration.',
        source: DM_SOURCE,
      }),
    ];
    if (!isDeploymentManager(doc)) return out;
    const names = new Set        ();
    (doc.resources          ).forEach((r, i) => {
      if (!isObj(r)) return;
      const name = str(r.name)          ;
      if (names.has(name)) out.push(error('gcp.dm.name.duplicate', `Two resources are named ${name}.`, { path: pathString(['resources', i, 'name']) }));
      names.add(name);
    });
    const text = JSON.stringify(doc);
    for (const m of text.matchAll(/\$\(ref\.([^.)]+)\./g)) {
      if (!names.has(m[1]          )) out.push(error('gcp.dm.ref', `$(ref.${m[1]}…) names no resource in this configuration.`, { path: 'resources' }));
    }
    return out;
  },
  itemTitle: (value) => (isObj(value) ? str(value.name) : undefined),
};

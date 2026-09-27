/**
 * Identity: where the domain lives on each platform. Nothing is invented.
 *
 * - **Extending Active Directory into a cloud** (domain controllers there) only
 *   when the plan's strategy is extend-dcs (the wizard's hybrid AD + Entra
 *   identity model) AND the user said "extend AD into this cloud: yes" for
 *   this cloud (`<platform>:identity:extend-ad`) AND gave the domain
 *   controllers' names (`<platform>:identity:dc-names`, their own naming
 *   convention). Then those DCs are built, promoted into the forest by
 *   Ansible (never replicated), in the management subnets the user added.
 *   When the plan already sends domain controllers (role ad-dc) to the
 *   platform, those are used.
 * - **managed-ad**: AWS Managed Microsoft AD, Microsoft Entra Domain Services,
 *   Managed Service for Microsoft AD. OCI has none.
 * - Otherwise Identity says what signs people in (Entra ID, IAM Identity
 *   Center, Cloud Identity, OCI IAM, the existing IdP) and builds nothing.
 * - VCF on owned hardware keeps using the existing domain controllers.
 */

import { error, info, warning,              } from '../../../core/findings.js';
import { itemId, overrideKey } from '../options.js';
                                                                                                                   
import { computeTargetFor, noSubnetFinding, spreadAcrossZones } from './compute.js';
                                                              
import { placeWorkload } from './network.js';

/** The strategy that applies on a platform (OCI has no managed AD). */
export function strategyFor(requested            , platform          )             {
  return requested === 'managed-ad' && platform === 'oci' ? 'extend-dcs' : requested;
}

/** The managed directory service per platform, for the card and the generators. */
export const MANAGED_AD                                                                                               = {
  aws: { service: 'AWS Managed Microsoft AD (Enterprise)', resource: 'aws_directory_service_directory' },
  azure: { service: 'Microsoft Entra Domain Services', resource: 'azurerm_active_directory_domain_service' },
  google: { service: 'Managed Service for Microsoft Active Directory', resource: 'google_active_directory_domain' },
};

/** What signs people in on each cloud when no directory is built there. */
export const CLOUD_SIGN_IN_TEXT                                     = {
  aws: 'AWS IAM Identity Center',
  azure: 'Microsoft Entra ID',
  google: 'Cloud Identity',
  oci: 'OCI IAM (identity domains)',
  vmware: 'vCenter single sign-on with the existing directory',
};

/** The sign-in the plan chose, named for the cloud. */
export function signInText(signIn             , platform          )         {
  return signIn === 'existing-idp-saml' ? `the existing identity provider (SAML) federated to ${CLOUD_SIGN_IN_TEXT[platform]}` : CLOUD_SIGN_IN_TEXT[platform];
}

/** The per-cloud identity keys (Landing zones, wizard step 6). */
export const identityKey = (platform          , field                          )         => overrideKey(platform, 'identity', field);

/** The DC names the user gave for a cloud (comma- or space-separated), cleaned. */
export function dcNamesFor(plan                               , platform          )           {
  const raw = plan.designOverrides[identityKey(platform, 'dc-names')] ?? '';
  return [...new Set(raw.split(/[\s,;]+/).map((n) => n.trim().toLowerCase()).filter(Boolean))];
}

/** Did the user say to extend AD into this cloud. */
export const extendsAd = (plan                               , platform          )          => (plan.designOverrides[identityKey(platform, 'extend-ad')] ?? '') === 'yes';

/** The domain controllers the user named for a platform (not plan rows; ids from their names). */
export function dcWorkloads(plan      , platform          , names                    = dcNamesFor(plan, platform))             {
  const ahb = platform === 'azure' && plan.requirements.licensing.microsoftSa === 'yes-all';
  return names.map((name) => ({
    id: itemId('workload', name),
    name,
    app: 'Active Directory',
    env: 'prod',
    role: 'ad-dc',
    os: 'win-2025',
    vcpu: 2,
    ramGib: 8,
    disksGib: [128],
    criticality: 'tier0',
    rpo: '15m',
    rto: '1h',
    licence: ahb ? 'byol-sa' : 'li',
    dependsOn: [],
    source: 'manual',
  }                   ));
}

/** The plan's workloads plus the domain controllers the design builds, for the generators. */
export function designWorkloads(plan      , design              )             {
  const known = new Set(plan.workloads.map((w) => w.id));
  const added = design.platforms.filter((pd                ) => pd.identity.builds).flatMap((pd) => dcWorkloads(plan, pd.platform, pd.identity.dcNames));
  return [...plan.workloads, ...added.filter((w) => !known.has(w.id))];
}

export const identityMapper               = {
  id: 'identity',
  map(ctx               , design) {
    const findings            = [];
    const { plan, platform } = ctx;
    const req = plan.requirements.identity;
    const strategy = strategyFor(req.adStrategy, platform);
    if (req.adStrategy === 'managed-ad' && platform === 'oci') {
      findings.push(warning('design.identity.oci-no-managed-ad', 'OCI has no managed Microsoft AD: extend AD into OCI (with the domain controllers\' names) or sign in with OCI IAM.', {
        path: identityKey(platform, 'extend-ad'),
      }));
    }
    if (strategy !== 'none' && !req.domain?.trim()) {
      findings.push(warning('design.identity.no-domain', 'No AD domain is set: the directory and domain join need its FQDN.', { path: 'requirements.identity.domain' }));
    }

    const existing = design.compute.filter((c) => ctx.workloads.some((w) => w.id === c.workload && w.role === 'ad-dc'));
    const existingNames = existing.map((c) => ctx.workloads.find((w) => w.id === c.workload) .name);
    if (strategy !== 'extend-dcs' || platform === 'vmware') {
      if (platform === 'vmware' && strategy !== 'none') {
        findings.push(info('design.identity.vmware-existing', 'VCF on owned hardware uses the existing domain controllers: none are added.'));
      }
      if (strategy === 'none') {
        findings.push(info('design.identity.sign-in', `${platform}: sign-in is ${signInText(req.cloudSignIn, platform)}; no directory is built.`));
      }
      return { design: { ...design, identity: { strategy, dcNames: existingNames } }, findings };
    }

    if (existing.length > 0) {
      if (existing.length === 1) {
        findings.push(warning('design.identity.one-dc', `${platform} gets one domain controller from the plan (${existingNames[0]}); a second, in another zone, keeps sign-in working through a zone outage.`));
      }
      const spread = spreadAcrossZones(design, existing.map((c) => c.workload), `${platform} domain controllers`);
      findings.push(...spread.findings);
      return { design: { ...design, compute: spread.compute, identity: { strategy, dcNames: existingNames } }, findings };
    }

    if (!extendsAd(plan, platform)) {
      findings.push(info('design.identity.not-extended', `${platform}: Active Directory is not extended into this cloud (Extend AD into this cloud is not "yes"), so no domain controller is built; sign-in is ${signInText(req.cloudSignIn, platform)}, and domain-joined VMs reach the domain over the link to the data centre.`, {
        path: identityKey(platform, 'extend-ad'),
      }));
      return { design: { ...design, identity: { strategy, dcNames: [] } }, findings };
    }
    const names = dcNamesFor(plan, platform);
    if (names.length === 0) {
      findings.push(error('design.identity.no-dc-names', `${platform}: AD is extended into this cloud, but no domain controller names are given: give them, following your naming convention.`, {
        path: identityKey(platform, 'dc-names'),
      }));
      return { design: { ...design, identity: { strategy, dcNames: [] } }, findings };
    }
    if (names.length === 1) {
      findings.push(warning('design.identity.one-dc', `${platform}: one domain controller (${names[0]}); a second, in another zone, keeps sign-in working through a zone outage.`));
    }
    const dcs = dcWorkloads(plan, platform, names);
    const placed = placeWorkload(design, 'prod', 'mgmt');
    if (!placed) {
      findings.push(noSubnetFinding(platform, dcs[0] , 'mgmt'));
      return { design: { ...design, identity: { strategy, dcNames: names } }, findings };
    }
    if (placed.zones.length < 2 && dcs.length > 1) {
      findings.push(info('design.compute.ha-single-zone', `${platform}: the management subnets are in one zone, so the domain controllers share it.`));
    }
    const added = dcs.map((w, i) => {
      const r = computeTargetFor(ctx, w, { network: placed.network, zone: placed.zones[i % Math.max(1, placed.zones.length)] ?? '' });
      findings.push(...r.findings);
      return r.target;
    });
    return {
      design: { ...design, compute: [...design.compute, ...added], identity: { strategy, dcNames: names, builds: true } },
      findings,
    };
  },
};

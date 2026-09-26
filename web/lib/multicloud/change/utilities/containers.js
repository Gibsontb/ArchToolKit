/**
 * Scale a node pool (addendum A.9.2).
 *
 * A cluster an app stack manages (a `containers` component of a planned app)
 * is scaled through the plan: the component's `nodes_min`, `nodes_max` and
 * `node_size` settings, and the stack's diff (the EKS node group's
 * scaling_config, the AKS pool, the GKE node pool, the OKE node pool). Any
 * other cluster is scaled with the platform's CLI, recording the old
 * scaling first; a VKS cluster by patching its Cluster's
 * `topology.workers.machineDeployments[].replicas` with kubectl.
 */

import { code } from '../../plan/execute/lib-sh.js';
import { appPlanOf, findApp } from '../../plan/apps/components.js';
                                                                                    
import {
  ALL_PLATFORMS, CLI_OF, OCI_COMPARTMENT_INPUT, PLATFORM_LABELS, ROUTE_INPUT, error, info, numVal, on, opt, platformInput, platformOf, routeOf, shq, stackChange,
  val, warning,
                                                                    
} from './common.js';

/** The containers component a `<app>/<component>` reference names, on a platform. */
function clusterComponent(plan                  , ref        , platform          )                                                             {
  if (!plan || !ref.includes('/')) return undefined;
  const [appName = '', compName = ''] = ref.split('/');
  const app = findApp(plan, appName);
  const ap = app ? appPlanOf(plan, app.id) : undefined;
  if (!app || !ap || ap.platform !== platform || (ap.status !== 'planned' && ap.status !== 'approved')) return undefined;
  const c = (ap.variants[platform] ?? []).find((x) => x.kind === 'pattern' && (x.name === compName || x.id === compName) && x.tierPattern === 'containers');
  return c && c.kind === 'pattern' ? { appId: app.id, component: c } : undefined;
}

function scaleSh(platform          , cluster        , pool        , loc        )                               {
  const c = shq(cluster);
  const p = shq(pool);
  switch (platform) {
    case 'aws':
      return {
        read: code`aws eks describe-nodegroup --cluster-name ${c} --nodegroup-name ${p} --query 'nodegroup.scalingConfig' --output json | jq -c '{min: .minSize, max: .maxSize, count: .desiredSize}'`,
        fn: code`scale_to() {
  local cur
  cur="$(read_scaling)"
  if [[ "$(jq -c --argjson min "$1" --argjson max "$2" --argjson count "$3" '. == {min: $min, max: $max, count: $count}' <<< "$cur")" == true ]]; then atk_log "the pool is at $cur already"; return 0; fi
  atk_run aws eks update-nodegroup-config --cluster-name ${c} --nodegroup-name ${p} --scaling-config "minSize=$1,maxSize=$2,desiredSize=$3" --output text
}`,
      };
    case 'azure':
      return {
        read: code`az aks nodepool show --resource-group ${shq(loc)} --cluster-name ${c} --name ${p} -o json | jq -c '{min: .minCount, max: .maxCount, count: .count}'`,
        fn: code`scale_to() {
  local cur
  cur="$(read_scaling)"
  if [[ "$(jq -c --argjson min "$1" --argjson max "$2" '.min == $min and .max == $max' <<< "$cur")" == true ]]; then atk_log "the pool is at $cur already"; return 0; fi
  if [[ "$(jq -r '.min' <<< "$cur")" == null ]]; then
    atk_run az aks nodepool update --resource-group ${shq(loc)} --cluster-name ${c} --name ${p} --enable-cluster-autoscaler --min-count "$1" --max-count "$2" --output none
  else
    atk_run az aks nodepool update --resource-group ${shq(loc)} --cluster-name ${c} --name ${p} --update-cluster-autoscaler --min-count "$1" --max-count "$2" --output none
  fi
}`,
      };
    case 'google':
      return {
        read: code`gcloud container node-pools describe ${p} --cluster ${c} --location ${shq(loc)} --format=json | jq -c '{min: .autoscaling.minNodeCount, max: .autoscaling.maxNodeCount, count: .initialNodeCount}'`,
        fn: code`scale_to() {
  local cur
  cur="$(read_scaling)"
  if [[ "$(jq -c --argjson min "$1" --argjson max "$2" '.min == $min and .max == $max' <<< "$cur")" == true ]]; then atk_log "the pool is at $cur already"; return 0; fi
  atk_run gcloud container node-pools update ${p} --cluster ${c} --location ${shq(loc)} --enable-autoscaling --min-nodes "$1" --max-nodes "$2" --quiet
  atk_run gcloud container clusters resize ${c} --node-pool ${p} --location ${shq(loc)} --num-nodes "$3" --quiet
}`,
      };
    case 'oci':
      return {
        read: code`oci ce node-pool get --node-pool-id "$(pool_id)" | jq -c '{min: .data["node-config-details"].size, max: .data["node-config-details"].size, count: .data["node-config-details"].size}'`,
        fn: code`COMPARTMENT=${shq(loc)}
COMPARTMENT="$\{COMPARTMENT:-$\{OCI_COMPARTMENT_ID:-}}"
if [[ -z "$COMPARTMENT" ]]; then change_stop 3 "set OCI_COMPARTMENT_ID (or the utility's compartment)"; fi
pool_id() {
  local cid
  cid="$(oci ce cluster list --compartment-id "$COMPARTMENT" --name ${c} --lifecycle-state ACTIVE --query 'data[0].id' --raw-output)"
  oci ce node-pool list --compartment-id "$COMPARTMENT" --cluster-id "$cid" --name ${p} --query 'data[0].id' --raw-output
}
scale_to() {
  local cur
  cur="$(read_scaling)"
  if [[ "$(jq -r '.count' <<< "$cur")" == "$3" ]]; then atk_log "the pool has $3 nodes already"; return 0; fi
  atk_run oci ce node-pool update --node-pool-id "$(pool_id)" --size "$3" --force
}`,
      };
    default:
      return {
        read: code`kubectl get cluster ${c} --namespace ${shq(loc)} -o json | jq -c --arg p ${p} '.spec.topology.workers.machineDeployments[] | select(.name == $p) | {min: .replicas, max: .replicas, count: .replicas}'`,
        fn: code`scale_to() {
  local idx cur
  cur="$(read_scaling)"
  if [[ "$(jq -r '.count' <<< "$cur")" == "$3" ]]; then atk_log "the pool has $3 nodes already"; return 0; fi
  idx="$(kubectl get cluster ${c} --namespace ${shq(loc)} -o json | jq --arg p ${p} '.spec.topology.workers.machineDeployments | map(.name) | index($p)')"
  if [[ "$idx" == null ]]; then change_stop 5 "no machine deployment ${pool} in the cluster"; fi
  atk_run kubectl patch cluster ${c} --namespace ${shq(loc)} --type json -p "[{\"op\": \"replace\", \"path\": \"/spec/topology/workers/machineDeployments/$idx/replicas\", \"value\": $3}]"
}`,
      };
  }
}

export const scaleNodePool                = {
  id: 'scale-node-pool',
  label: 'Scale a node pool',
  category: 'containers',
  description: 'New minimum, maximum and node count (and, through the plan, node size) for a Kubernetes node pool: the app stack\'s Terraform when a stack manages the cluster (EKS node group, AKS node pool, GKE node pool, OKE node pool), else the platform\'s CLI; a VKS cluster by patching its Cluster manifest with kubectl.',
  platforms: ALL_PLATFORMS,
  risk: 'medium',
  reversible: true,
  rollback: 'Puts the old scaling back (the stack\'s old files, or the scaling recorded before the change).',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'cluster', label: 'Cluster', control: 'combo', default: 'shop/cluster', from: 'cluster', hint: 'An app\'s containers component (app/component) or a cluster name.' },
    { id: 'pool', label: 'Node pool', control: 'text', default: 'default', hint: 'The node group / node pool / machine deployment name.' },
    { id: 'nodes_min', label: 'Minimum', control: 'number', default: 3, min: 0, max: 1000 },
    { id: 'nodes_max', label: 'Maximum', control: 'number', default: 6, min: 1, max: 1000 },
    { id: 'count', label: 'Nodes now', control: 'number', default: 3, min: 0, max: 1000 },
    { id: 'node_size', label: 'Node size (through the plan)', control: 'text', default: '', hint: 'A new node size needs a new pool: only through the plan.' },
    { id: 'resource_group', label: 'Resource group', control: 'text', default: 'shop-aks-rg', ...on('azure') },
    { id: 'location', label: 'Location', control: 'text', default: 'europe-west2', hint: 'The cluster\'s region or zone.', ...on('google') },
    { id: 'namespace', label: 'vSphere Namespace', control: 'text', default: 'shop', ...on('vmware') },
    OCI_COMPARTMENT_INPUT,
    ROUTE_INPUT,
  ],
  build(values, ctx)                {
    const platform = platformOf(values, scaleNodePool);
    const findings            = [];
    const ref = val(values, 'cluster', 'shop/cluster');
    const pool = val(values, 'pool', 'default');
    const min = numVal(values, 'nodes_min', 3);
    const max = numVal(values, 'nodes_max', 6);
    const count = Math.min(max, Math.max(min, numVal(values, 'count', min)));
    if (min > max) findings.push(error('change.pool.range', 'The minimum is above the maximum.', { path: 'nodes_min' }));
    const size = val(values, 'node_size');
    const managed = clusterComponent(ctx.plan, ref, platform);
    const route = routeOf(values, !!managed, findings);
    if (route === 'plan' && managed && ctx.plan) {
      const s = managed.component.settings;
      const to                                     = { nodes_min: String(min), nodes_max: String(max), ...(size ? { node_size: size } : {}) };
      const from                                     = Object.fromEntries(Object.keys(to).map((k) => [k, s[k]]));
      const ops           = [{ op: 'component-settings', app: managed.appId, platform, component: managed.component.id, from, to }];
      const sc = stackChange(ctx.plan, ops, managed.appId, platform, ctx);
      findings.push(...sc.findings);
      if (sc.changed) {
        return { platform, target: ref, route: 'plan', summary: `Scale ${ref} to ${min}-${max} nodes${size ? ` of ${size}` : ''} through its app stack`, files: sc.files, findings, apply: sc.apply, rollback: sc.rollback, needs: [], planOps: ops };
      }
    }
    if (size) findings.push(warning('change.pool.size', 'A new node size needs a new node pool: that is only done through the plan; the size is ignored here.', { path: 'node_size' }));
    const cluster = ref.includes('/') ? ref.split('/').pop()  : ref;
    const loc = platform === 'oci' ? val(values, 'compartment_id') : platform === 'azure' ? val(values, 'resource_group') : platform === 'google' ? val(values, 'location') : val(values, 'namespace', 'shop');
    if ((platform === 'azure' || platform === 'google') && !loc) findings.push(error('change.pool.location', `${PLATFORM_LABELS[platform]} needs the ${platform === 'azure' ? 'resource group' : 'location'} of the cluster.`, { path: platform === 'azure' ? 'resource_group' : 'location' }));
    if (platform === 'aws' || platform === 'azure' || platform === 'google') {
      if (count !== numVal(values, 'count', min)) findings.push(info('change.pool.count', `The node count is kept between the minimum and the maximum: ${count}.`));
    }
    const sh = scaleSh(platform, cluster, pool, loc);
    const head = `read_scaling() { ${sh.read}; }\n${sh.fn}`;
    return {
      platform, target: `${cluster}/${pool}`, route: 'cli', summary: `Scale ${cluster}/${pool} to ${min}-${max} (${count} now) on ${PLATFORM_LABELS[platform]}`, files: {}, findings,
      apply: [{ kind: 'sh', title: `Scale ${pool}`, body: `${head}\nchange_remember scaling "$(read_scaling)"\nscale_to ${min} ${max} ${count}` }],
      rollback: [{ kind: 'sh', title: `Put ${pool}'s old scaling back`, body: `${head}\nprev="$(change_recall scaling)"\nif [[ -z "$prev" ]]; then change_stop 5 "no scaling recorded: apply.sh has not run (or ran with --dry-run)"; fi\nscale_to "$(jq -r '.min // .count' <<< "$prev")" "$(jq -r '.max // .count' <<< "$prev")" "$(jq -r '.count // .min' <<< "$prev")"` }],
      needs: [platform === 'vmware' ? 'kubectl' : CLI_OF[platform], 'jq'],
      ...(platform === 'vmware' ? { notes: ['kubectl uses the Supervisor context of the vSphere Namespace (kubectl vsphere login, or the VCF Consumption CLI).'] } : {}),
    };
  },
};

export const CONTAINER_UTILITIES                           = [scaleNodePool];

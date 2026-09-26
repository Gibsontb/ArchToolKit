/**
 * Governance utilities (addendum A.9.2): tag changes, a budget, a
 * monitoring alert.
 *
 * Tags on servers an app stack manages are written to the plan
 * (`compute:<id>:tags`) as well as applied, and the finding says whether the
 * stack carries them; everything else is the platform's CLI (merged, so a
 * tag set the platform replaces whole, OCI's, keeps the other tags) or VCF
 * PowerCLI. Budgets and alerts are Terraform in the landing zone.
 */

                                                                 
import { code } from '../../plan/execute/lib-sh.js';
import { overrideKey } from '../../plan/options.js';
import { appWorkloads, findApp } from '../../plan/apps/components.js';
import { q } from '../../../terraform/blueprints/migration/common.js';
                                                
import {
  ALL_PLATFORMS, CLI_OF, HYPERSCALERS, NETWORK_INPUTS, OCI_COMPARTMENT_INPUT, PLATFORM_LABELS, RG_INPUT, ZONE_INPUT, appInput, error, info, instanceLookup,
  locateSh, locationLocals, locationVars, managingApp, numVal, on, opt, platformInput, platformOf, psq, safeName, serverInput, shq, stackChange, tfRoot, val,
  vcfTool, warning,
                                                                                                                                     
} from './common.js';

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** `Key | Value` lines. */
export function parseTags(text        )                         {
  const out                         = {};
  for (const line of text.split('\n')) {
    const [k = '', ...rest] = line.split('|');
    const key = k.trim();
    if (key) out[key] = rest.join('|').trim();
  }
  return out;
}

/** Bash: tags_read (a JSON object of the server's tags), tags_set JSON, tags_unset KEY... for the located server. */
export function tagFnsSh(platform          )         {
  switch (platform) {
    case 'aws':
      return code`tags_read() { aws ec2 describe-tags --filters "Name=resource-id,Values=$SID" --query 'Tags' --output json | jq -c 'map({(.Key): .Value}) | add // {}'; }
tags_set() {
  local -a args=()
  mapfile -t args < <(jq -r 'to_entries[] | "Key=\(.key),Value=\(.value)"' <<< "$1")
  if (( $\{#args[@]} )); then atk_run aws ec2 create-tags --resources "$SID" --tags "$\{args[@]}"; fi
}
tags_unset() {
  local -a args=()
  local k
  for k in "$@"; do args+=("Key=$k"); done
  if (( $\{#args[@]} )); then atk_run aws ec2 delete-tags --resources "$SID" --tags "$\{args[@]}"; fi
}`;
    case 'azure':
      return code`RID="$(az vm show --resource-group "$RG" --name "$SERVER" --query id -o tsv)"
tags_read() { az tag list --resource-id "$RID" --query properties.tags -o json | jq -c '. // {}'; }
tags_set() {
  local -a args=()
  mapfile -t args < <(jq -r 'to_entries[] | "\(.key)=\(.value)"' <<< "$1")
  if (( $\{#args[@]} )); then atk_run az tag update --resource-id "$RID" --operation merge --tags "$\{args[@]}" --output none; fi
}
tags_unset() {
  local -a args=()
  mapfile -t args < <(tags_read | jq -r --args 'to_entries[] | select(.key as $k | $ARGS.positional | index($k)) | "\(.key)=\(.value)"' "$@")
  if (( $\{#args[@]} )); then atk_run az tag update --resource-id "$RID" --operation delete --tags "$\{args[@]}" --output none; fi
}`;
    case 'google':
      return code`tags_read() { gcloud compute instances describe "$SERVER" --zone "$ZONE" --format=json | jq -c '.labels // {}'; }
tags_set() {
  local l
  l="$(jq -r 'to_entries | map("\(.key)=\(.value)") | join(",")' <<< "$1")"
  if [[ -n "$l" ]]; then atk_run gcloud compute instances add-labels "$SERVER" --zone "$ZONE" --labels "$l" --quiet; fi
}
tags_unset() {
  local l
  l="$(IFS=,; printf '%s' "$*")"
  if [[ -n "$l" ]]; then atk_run gcloud compute instances remove-labels "$SERVER" --zone "$ZONE" --labels "$l" --quiet; fi
}`;
    case 'oci':
      return code`tags_read() { oci compute instance get --instance-id "$SID" | jq -c '.data["freeform-tags"] // {}'; }
# OCI replaces the whole set: merge with what is there.
tags_set() {
  local all
  all="$(tags_read | jq -c --argjson add "$1" '. + $add')"
  atk_run oci compute instance update --instance-id "$SID" --freeform-tags "$all" --force
}
tags_unset() {
  local all
  all="$(tags_read | jq -c --args 'delpaths([$ARGS.positional[] | [.]])' "$@")"
  atk_run oci compute instance update --instance-id "$SID" --freeform-tags "$all" --force
}`;
    default:
      return '';
  }
}

/**
 * Bash for one server: record the tags it has for the keys the change
 * touches, then set and unset; the rollback puts the recorded values back.
 */
export function tagStepsSh(platform          , server        , values                 , add                                  , remove                   )                                      {
  const key = `${safeName(server)}:tags`;
  const keys = [...Object.keys(add), ...remove];
  const head = `${locateSh(platform, server, values)}\n${tagFnsSh(platform)}`;
  return {
    apply: `${head}
prev="$(tags_read | jq -c --args '. as $t | reduce $ARGS.positional[] as $k ({}; .[$k] = ($t[$k] // null))' ${keys.map(shq).join(' ')})"
change_remember ${key} "$prev"
tags_set ${shq(JSON.stringify(add))}
${remove.length ? `tags_unset ${remove.map(shq).join(' ')}` : ''}`,
    rollback: `${head}
prev="$(change_recall ${key})"
if [[ -z "$prev" ]]; then change_stop 5 "no tags recorded for ${server}: apply.sh has not run (or ran with --dry-run)"; fi
tags_set "$(jq -c 'with_entries(select(.value != null))' <<< "$prev")"
mapfile -t gone < <(jq -r 'to_entries[] | select(.value == null) | .key' <<< "$prev")
if (( \${#gone[@]} )); then tags_unset "\${gone[@]}"; fi`,
  };
}

function tagsVcf(servers                   , add                                  , remove                   )         {
  const addList = Object.entries(add).map(([k, v]) => `@{ Category = ${psq(k)}; Tag = ${psq(v)} }`).join(', ');
  return `$servers = @(${servers.map(psq).join(', ')})
$add = @(${addList})
$remove = @(${remove.map(psq).join(', ')})
foreach ($name in $servers) {
  $vm = Get-ChangeVm -Name $name
  $key = "$($name):tags"
  if ($Mode -eq 'apply') {
    $have = @(Get-TagAssignment -Entity $vm -Server $vc | ForEach-Object { "$($_.Tag.Category.Name)=$($_.Tag.Name)" })
    if ($null -eq (Get-AtkId -Path 'change' -Key $key)) { Set-AtkId -Path 'change' -Key $key -Value ($have -join ';') }
    foreach ($t in $add) {
      $cat = Get-TagCategory -Server $vc -Name $t.Category -ErrorAction SilentlyContinue
      if (-not $cat) { $cat = Invoke-AtkStep "create the tag category $($t.Category)" { New-TagCategory -Server $vc -Name $t.Category -Cardinality Single -EntityType VirtualMachine } }
      $tag = if ($cat) { Get-Tag -Server $vc -Category $cat -Name $t.Tag -ErrorAction SilentlyContinue } else { $null }
      if (-not $tag -and $cat) { $tag = Invoke-AtkStep "create the tag $($t.Category)=$($t.Tag)" { New-Tag -Server $vc -Category $cat -Name $t.Tag } }
      $old = Get-TagAssignment -Entity $vm -Server $vc -Category $t.Category -ErrorAction SilentlyContinue
      if ($old -and $old.Tag.Name -eq $t.Tag) { Write-AtkLog "$name has $($t.Category)=$($t.Tag)"; continue }
      if ($old) { Invoke-AtkStep "remove $($t.Category) from $name" { $old | Remove-TagAssignment -Confirm:$false } }
      if ($tag) { Invoke-AtkStep "tag $name $($t.Category)=$($t.Tag)" { New-TagAssignment -Server $vc -Entity $vm -Tag $tag | Out-Null } }
    }
    foreach ($c in $remove) {
      $old = Get-TagAssignment -Entity $vm -Server $vc -Category $c -ErrorAction SilentlyContinue
      if ($old) { Invoke-AtkStep "remove $c from $name" { $old | Remove-TagAssignment -Confirm:$false } }
    }
  } else {
    $prev = Get-AtkId -Path 'change' -Key $key
    if ($null -eq $prev) { Stop-Atk 5 "no tags recorded for $($name): apply.sh has not run (or ran with -DryRun)" }
    $keep = @{}
    foreach ($p in ($prev -split ';' | Where-Object { $_ })) { $k, $v = $p -split '=', 2; $keep[$k] = $v }
    foreach ($c in @($add | ForEach-Object { $_.Category }) + $remove) {
      $old = Get-TagAssignment -Entity $vm -Server $vc -Category $c -ErrorAction SilentlyContinue
      if ($old -and $old.Tag.Name -ne $keep[$c]) { Invoke-AtkStep "remove $c from $name" { $old | Remove-TagAssignment -Confirm:$false } }
      if ($keep.ContainsKey($c) -and (-not $old -or $old.Tag.Name -ne $keep[$c])) {
        $tag = Get-Tag -Server $vc -Category $c -Name $keep[$c]
        Invoke-AtkStep "tag $name $c=$($keep[$c]) again" { New-TagAssignment -Server $vc -Entity $vm -Tag $tag | Out-Null }
      }
    }
  }
}`;
}

/** The servers a scope names: the listed ones, or the app's. */
function scopeServers(values                 , plan                  )           {
  if (val(values, 'scope', 'servers') === 'app' && plan) {
    const app = findApp(plan, val(values, 'app', 'shop'));
    if (app) return appWorkloads(plan, app).map((w) => w.name);
  }
  return val(values, 'server', 'app01').split(/[\s,]+/).filter(Boolean);
}

export const tags                = {
  id: 'tags',
  label: 'Tag changes',
  category: 'governance',
  description: 'Adds, changes or removes tags (Google Cloud (GCP): labels, lower-cased) on servers: AWS create-tags / delete-tags, az tag update --operation merge, gcloud add-labels / remove-labels, OCI freeform tags merged by the script (OCI replaces the set), VCF tag assignments. The plan records the tags of the servers it manages.',
  platforms: ALL_PLATFORMS,
  risk: 'low',
  reversible: true,
  rollback: 'Puts back the values the changed keys had before (and removes the keys that were not there).',
  source: 'A.9.2',
  inputs: [
    platformInput(ALL_PLATFORMS),
    { id: 'scope', label: 'Scope', control: 'select', default: 'servers', options: [opt('servers', 'Servers'), opt('app', 'Every server of an app')] },
    { ...serverInput('Servers', 'app01'), hint: 'Space-separated.', showWhen: { input: 'scope', equals: ['servers'] } },
    { ...appInput('shop'), showWhen: { input: 'scope', equals: ['app'] } },
    { id: 'add', label: 'Add or change', control: 'textarea', default: 'cost_centre | cc-1042', hint: 'Key | Value, one per line.' },
    { id: 'remove', label: 'Remove keys', control: 'text', default: '', hint: 'Space-separated.' },
    RG_INPUT, ZONE_INPUT, OCI_COMPARTMENT_INPUT,
  ],
  build(values, ctx)                {
    const platform = platformOf(values, tags);
    const findings            = [];
    let add = parseTags(val(values, 'add', 'cost_centre | cc-1042'));
    let remove = val(values, 'remove').split(/[\s,]+/).filter(Boolean);
    if (platform === 'google') {
      const lower = (s        )         => s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 63);
      if (Object.entries(add).some(([k, v]) => k !== lower(k) || (v !== lower(v)))) findings.push(info('change.tags.labels', 'Google Cloud (GCP) labels are lower case letters, digits, - and _: the keys and values are lower-cased.'));
      add = Object.fromEntries(Object.entries(add).map(([k, v]) => [lower(k), lower(v)]));
      remove = remove.map(lower);
    }
    if (Object.keys(add).some((k) => k.startsWith('atk_'))) findings.push(warning('change.tags.atk', 'atk_* tags are the toolkit\'s own (the inventory and backups read them); change them through the plan.', { path: 'add' }));
    if (!Object.keys(add).length && !remove.length) findings.push(error('change.tags.none', 'Nothing to add or remove.', { path: 'add' }));
    const servers = scopeServers(values, ctx.plan);
    if (!servers.length) findings.push(error('change.tags.no-servers', 'No servers in the scope.', { path: 'server' }));
    const ops           = [];
    for (const s of servers) {
      const m = managingApp(ctx.plan, s, platform);
      if (!m || !ctx.plan) continue;
      const k = overrideKey('compute', m.workload.id, 'tags');
      const from = ctx.plan.designOverrides[k];
      const cur = from ? (JSON.parse(from)                          ) : {};
      const next = { ...cur, ...add };
      for (const r of remove) delete next[r];
      ops.push({ op: 'override', key: k, ...(from !== undefined ? { from } : {}), to: JSON.stringify(next) });
    }
    if (ops.length && ctx.plan) {
      const m = managingApp(ctx.plan, servers.find((s) => managingApp(ctx.plan, s, platform)) , platform) ;
      const sc = stackChange(ctx.plan, ops, m.appId, platform, ctx);
      if (!sc.changed) {
        findings.push(warning('change.tags.stack', 'The app stack does not carry custom tags yet, so they are applied directly and recorded in the plan (compute:<id>:tags); the stack\'s next apply may remove them until it does.', { remediation: 'Apply this change again after the stack\'s next apply, or add the tags to the landing zone\'s default tags.' }));
      }
    }
    const summary = `Tags on ${servers.join(', ')}: ${[...Object.entries(add).map(([k, v]) => `${k}=${v}`), ...remove.map((r) => `-${r}`)].join(', ')}`;
    if (platform === 'vmware') {
      return {
        platform, target: servers.join(' '), route: 'cli', summary, findings, planOps: ops,
        files: { 'scripts/tags.ps1': vcfTool('scripts/tags.ps1', 'Tag assignments (apply) and the old ones back (rollback).', tagsVcf(servers, add, remove)) },
        apply: [{ kind: 'pwsh', title: 'Set the tags', file: 'scripts/tags.ps1', args: ['apply'] }],
        rollback: [{ kind: 'pwsh', title: 'Put the old tags back', file: 'scripts/tags.ps1', args: ['rollback'] }],
        needs: [],
      };
    }
    const steps = servers.map((s) => ({ s, t: tagStepsSh(platform, s, values, add, remove) }));
    return {
      platform, target: servers.join(' '), route: 'cli', summary, findings, planOps: ops, files: {},
      apply: steps.map(({ s, t })             => ({ kind: 'sh', title: `Tag ${s}`, body: t.apply })),
      rollback: steps.map(({ s, t })             => ({ kind: 'sh', title: `Put ${s}'s old tags back`, body: t.rollback })),
      needs: [CLI_OF[platform], 'jq'],
    };
  },
};

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

function budgetTf(platform          , values                 , ctx                , findings           )                                  {
  const name = safeName(val(values, 'name', 'shop-monthly'), 60);
  const amount = numVal(values, 'amount', 1000);
  const pct = numVal(values, 'alert_pct', 80);
  const emails = val(values, 'emails', 'finops@corp.example.com').split(/[\s,]+/).filter(Boolean);
  const app = val(values, 'scope', 'all') === 'app' ? val(values, 'app', 'shop') : '';
  const currency = val(values, 'currency', 'USD').toUpperCase();
  const list = `[${emails.map(q).join(', ')}]`;
  const vars          = [];
  switch (platform) {
    case 'aws':
      if (currency !== 'USD') findings.push(warning('change.budget.currency', 'AWS Budgets are in USD for most accounts; check the account\'s billing currency.', { path: 'currency' }));
      return {
        vars,
        main: `resource "aws_budgets_budget" "budget" {
  name         = ${q(name)}
  budget_type  = "COST"
  limit_amount = ${q(amount.toFixed(2))}
  limit_unit   = ${q(currency)}
  time_unit    = "MONTHLY"
${app ? `  cost_filter {\n    name   = "TagKeyValue"\n    values = [${q(`user:atk_app$${app}`)}]\n  }\n` : ''}  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = ${pct}
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = ${list}
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = ${list}
  }
}`,
      };
    case 'azure': {
      const day = (ctx.date ?? ctx.plan?.savedAt?.slice(0, 10) ?? '2026-01-01').slice(0, 7);
      return {
        vars,
        main: `resource "azurerm_consumption_budget_subscription" "budget" {
  name            = ${q(name)}
  subscription_id = "/subscriptions/\${var.landing_zone.subscription_id}"
  amount          = ${amount}
  time_grain      = "Monthly"
  time_period {
    start_date = ${q(`${day}-01T00:00:00Z`)}
  }
${app ? `  filter {\n    tag {\n      name   = "atk_app"\n      values = [${q(app)}]\n    }\n  }\n` : ''}  notification {
    enabled        = true
    threshold      = ${pct}
    operator       = "GreaterThan"
    threshold_type = "Actual"
    contact_emails = ${list}
  }
  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThan"
    threshold_type = "Forecasted"
    contact_emails = ${list}
  }
}`,
      };
    }
    case 'google':
      vars.push({ name: 'billing_account', type: 'string', description: 'The Cloud Billing account id (XXXXXX-XXXXXX-XXXXXX).', value: val(values, 'billing_account', '000000-000000-000000') });
      if (!val(values, 'billing_account')) findings.push(warning('change.budget.billing', 'Give the Cloud Billing account id.', { path: 'billing_account' }));
      return {
        vars,
        main: `data "google_project" "this" {}

resource "google_billing_budget" "budget" {
  billing_account = var.billing_account
  display_name    = ${q(name)}
  budget_filter {
    projects = ["projects/\${data.google_project.this.number}"]
${app ? `    labels = {\n      atk_app = ${q(app.toLowerCase())}\n    }\n` : ''}  }
  amount {
    specified_amount {
      currency_code = ${q(currency)}
      units         = ${q(String(Math.round(amount)))}
    }
  }
  threshold_rules {
    threshold_percent = ${(pct / 100).toFixed(2)}
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }
}`,
      };
    default:
      vars.push({ name: 'tenancy_ocid', type: 'string', description: 'The tenancy OCID (budgets live in the root compartment).', value: val(values, 'tenancy_ocid') });
      if (!val(values, 'tenancy_ocid')) findings.push(warning('change.budget.tenancy', 'Give the tenancy OCID: OCI budgets are created in the root compartment.', { path: 'tenancy_ocid' }));
      return {
        vars,
        main: `resource "oci_budget_budget" "budget" {
  compartment_id = var.tenancy_ocid
  display_name   = ${q(name)}
  amount         = ${amount}
  reset_period   = "MONTHLY"
  target_type    = "${app ? 'TAG' : 'COMPARTMENT'}"
  targets        = [${app ? q(`atk_app.${app}`) : 'var.landing_zone.compartment_id'}]
}

resource "oci_budget_alert_rule" "actual" {
  budget_id      = oci_budget_budget.budget.id
  display_name   = ${q(`${name}-actual`)}
  threshold      = ${pct}
  threshold_type = "PERCENTAGE"
  type           = "ACTUAL"
  recipients     = ${q(emails.join(','))}
  message        = ${q(`Spending passed ${pct}% of the ${name} budget.`)}
}`,
      };
  }
}

export const budget                = {
  id: 'budget',
  label: 'Budget',
  category: 'governance',
  description: 'A monthly budget with alerts at a percentage and on the forecast: AWS Budgets, an Azure consumption budget on the subscription, a Cloud Billing budget, an OCI budget with an alert rule. The amount is yours to enter.',
  platforms: HYPERSCALERS,
  risk: 'low',
  reversible: true,
  rollback: 'Deletes the budget (terraform destroy).',
  source: 'A.9.2',
  inputs: [
    platformInput(HYPERSCALERS),
    { id: 'name', label: 'Name', control: 'text', default: 'shop-monthly' },
    { id: 'scope', label: 'Scope', control: 'select', default: 'all', options: [opt('all', 'The whole account, subscription, project or compartment'), opt('app', 'One app (its atk_app tag)')] },
    { ...appInput('shop'), showWhen: { input: 'scope', equals: ['app'] } },
    { id: 'amount', label: 'Monthly amount', control: 'number', default: 1000, min: 1 },
    { id: 'currency', label: 'Currency', control: 'text', default: 'USD', hint: 'The billing account\'s currency (AWS: USD).' },
    { id: 'alert_pct', label: 'Alert at %', control: 'number', default: 80, min: 1, max: 1000 },
    { id: 'emails', label: 'Alert emails', control: 'text', default: 'finops@corp.example.com', hint: 'Space-separated.' },
    { id: 'billing_account', label: 'Billing account', control: 'text', default: '', ...on('google') },
    { id: 'tenancy_ocid', label: 'Tenancy OCID', control: 'text', default: '', ...on('oci') },
  ],
  build(values, ctx)                {
    const platform = platformOf(values, budget);
    const findings            = [];
    const tf = budgetTf(platform, values, ctx, findings);
    const name = val(values, 'name', 'shop-monthly');
    return {
      platform, target: name, route: 'terraform', summary: `Budget ${name}: ${numVal(values, 'amount', 1000)} ${val(values, 'currency', 'USD')} a month, alert at ${numVal(values, 'alert_pct', 80)}% (${PLATFORM_LABELS[platform]})`,
      files: tfRoot({ platform, header: `The ${name} budget.`, main: tf.main, variables: tf.vars }), findings,
      apply: [{ kind: 'terraform', title: `Create the ${name} budget`, dir: 'terraform', lz: true }],
      rollback: [{ kind: 'terraform-destroy', title: `Delete the ${name} budget`, dir: 'terraform', lz: true }],
      needs: [],
      notes: ['VCF: budgets and showback are VCF Operations settings, not Terraform, so this utility does not offer VCF.'],
    };
  },
};

// ---------------------------------------------------------------------------
// Monitoring alert
// ---------------------------------------------------------------------------

                                                         
export const ALERT_METRICS                                                                   = {
  aws: ['cpu', 'memory', 'disk', 'availability'],
  azure: ['cpu', 'memory', 'availability'],
  google: ['cpu', 'memory', 'disk'],
  oci: ['cpu', 'memory'],
};
const METRIC_LABELS                                   = {
  cpu: 'CPU utilisation %', memory: 'Memory used % (Azure: available GiB below)', disk: 'Disk used % (the platform\'s agent)', availability: 'Availability (status check failed)',
};

function alertTf(platform                             , metric        , threshold        , name        , emails                   , values                 )                                  {
  const t = instanceLookup(platform);
  const vars          = [...locationVars(platform, values), { name: 'server', type: 'string', description: 'The server the alert watches (found by name).', value: val(values, 'server', 'app01') }];
  const head = `${locationLocals(platform)}\n\n${t.hcl}`;
  const minutes = numVal(values, 'minutes', 15);
  switch (platform) {
    case 'aws': {
      const [ns, m, op, th] = metric === 'cpu' ? ['AWS/EC2', 'CPUUtilization', 'GreaterThanOrEqualToThreshold', threshold]
        : metric === 'availability' ? ['AWS/EC2', 'StatusCheckFailed', 'GreaterThanOrEqualToThreshold', 1]
        : metric === 'memory' ? ['CWAgent', 'mem_used_percent', 'GreaterThanOrEqualToThreshold', threshold]
        : ['CWAgent', 'disk_used_percent', 'GreaterThanOrEqualToThreshold', threshold];
      return {
        vars,
        main: `${head}

resource "aws_sns_topic" "alerts" {
  name              = ${q(`${name}-alerts`)}
  kms_master_key_id = "alias/aws/sns"
}

${emails.map((e, i) => `resource "aws_sns_topic_subscription" "email_${i + 1}" {\n  topic_arn = aws_sns_topic.alerts.arn\n  protocol  = "email"\n  endpoint  = ${q(e)}\n}`).join('\n\n')}

resource "aws_cloudwatch_metric_alarm" "alert" {
  alarm_name          = ${q(name)}
  alarm_description   = ${q(`${METRIC_LABELS[metric]} on the server`)}
  namespace           = ${q(ns          )}
  metric_name         = ${q(m          )}
  statistic           = "${metric === 'availability' ? 'Maximum' : 'Average'}"
  period              = 300
  evaluation_periods  = ${Math.max(1, Math.round(minutes / 5))}
  comparison_operator = ${q(op          )}
  threshold           = ${th}
  treat_missing_data  = "${metric === 'availability' ? 'breaching' : 'missing'}"
  dimensions = {
    InstanceId = ${t.id}
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}`,
      };
    }
    case 'azure': {
      const [m, op, th, agg] = metric === 'cpu' ? ['Percentage CPU', 'GreaterThan', threshold, 'Average']
        : metric === 'memory' ? ['Available Memory Bytes', 'LessThan', threshold * 1024 ** 3, 'Average']
        : ['VmAvailabilityMetric', 'LessThan', 1, 'Average'];
      const iso = `PT${minutes}M`;
      return {
        vars,
        main: `${head}

resource "azurerm_monitor_action_group" "alerts" {
  name                = ${q(`${name}-alerts`)}
  resource_group_name = local.rg
  short_name          = ${q(name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'atkalerts')}
${emails.map((e, i) => `  email_receiver {\n    name                    = "email-${i + 1}"\n    email_address           = ${q(e)}\n    use_common_alert_schema = true\n  }`).join('\n')}
}

resource "azurerm_monitor_metric_alert" "alert" {
  name                = ${q(name)}
  resource_group_name = local.rg
  scopes              = [${t.id}]
  description         = ${q(METRIC_LABELS[metric])}
  severity            = ${numVal(values, 'severity', 2)}
  frequency           = "PT5M"
  window_size         = ${q(['PT5M', 'PT15M', 'PT30M', 'PT1H'].includes(iso) ? iso : 'PT15M')}
  criteria {
    metric_namespace = "Microsoft.Compute/virtualMachines"
    metric_name      = ${q(m          )}
    aggregation      = ${q(agg          )}
    operator         = ${q(op          )}
    threshold        = ${th}
  }
  action {
    action_group_id = azurerm_monitor_action_group.alerts.id
  }
}`,
      };
    }
    case 'google': {
      const filter = metric === 'cpu' ? 'metric.type=\\"compute.googleapis.com/instance/cpu/utilization\\" AND resource.type=\\"gce_instance\\"'
        : metric === 'memory' ? 'metric.type=\\"agent.googleapis.com/memory/percent_used\\" AND resource.type=\\"gce_instance\\" AND metric.label.state=\\"used\\"'
        : 'metric.type=\\"agent.googleapis.com/disk/percent_used\\" AND resource.type=\\"gce_instance\\" AND metric.label.state=\\"used\\"';
      const th = metric === 'cpu' ? threshold / 100 : threshold;
      return {
        vars,
        main: `${head}

${emails.map((e, i) => `resource "google_monitoring_notification_channel" "email_${i + 1}" {\n  display_name = ${q(`${name} ${e}`)}\n  type         = "email"\n  labels = {\n    email_address = ${q(e)}\n  }\n}`).join('\n\n')}

resource "google_monitoring_alert_policy" "alert" {
  display_name = ${q(name)}
  combiner     = "OR"
  conditions {
    display_name = ${q(METRIC_LABELS[metric])}
    condition_threshold {
      filter          = "${filter} AND resource.label.instance_id=\\"\${${t.ref}.instance_id}\\""
      duration        = "${minutes * 60}s"
      comparison      = "COMPARISON_GT"
      threshold_value = ${th}
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = [${emails.map((_, i) => `google_monitoring_notification_channel.email_${i + 1}.id`).join(', ')}]
}`,
      };
    }
    default: {
      const m = metric === 'memory' ? 'MemoryUtilization' : 'CpuUtilization';
      return {
        vars,
        main: `${head}

resource "oci_ons_notification_topic" "alerts" {
  compartment_id = var.landing_zone.compartment_id
  name           = ${q(`${name}-alerts`)}
}

${emails.map((e, i) => `resource "oci_ons_subscription" "email_${i + 1}" {\n  compartment_id = var.landing_zone.compartment_id\n  topic_id       = oci_ons_notification_topic.alerts.id\n  protocol       = "EMAIL"\n  endpoint       = ${q(e)}\n}`).join('\n\n')}

resource "oci_monitoring_alarm" "alert" {
  compartment_id        = var.landing_zone.compartment_id
  metric_compartment_id = var.landing_zone.compartment_id
  display_name          = ${q(name)}
  is_enabled            = true
  namespace             = "oci_computeagent"
  query                 = "${m}[5m]{resourceId = \\"\${${t.id}}\\"}.mean() > ${threshold}"
  severity              = "${numVal(values, 'severity', 2) <= 1 ? 'CRITICAL' : 'WARNING'}"
  pending_duration      = "PT${minutes}M"
  destinations          = [oci_ons_notification_topic.alerts.id]
  body                  = ${q(`${METRIC_LABELS[metric]} above ${threshold}.`)}
}`,
      };
    }
  }
}

export const monitoringAlert                = {
  id: 'monitoring-alert',
  label: 'Add a monitoring alert',
  category: 'governance',
  description: 'A metric alert on a server with an email target: a CloudWatch alarm and an SNS topic, an Azure Monitor metric alert and action group, a Cloud Monitoring alert policy and email channels, an OCI Monitoring alarm and a Notifications topic.',
  platforms: HYPERSCALERS,
  risk: 'low',
  reversible: true,
  rollback: 'Deletes the alert and its topic, action group or channels (terraform destroy).',
  source: 'A.9.2',
  inputs: [
    platformInput(HYPERSCALERS),
    serverInput(),
    { id: 'metric', label: 'Metric', control: 'select', default: 'cpu', options: (['cpu', 'memory', 'disk', 'availability']            ).map((m) => opt(m, METRIC_LABELS[m])), hint: 'Memory and disk need the platform\'s agent (CloudWatch agent, Ops Agent, OCI Compute Instance Monitoring).' },
    { id: 'threshold', label: 'Threshold', control: 'number', default: 90, min: 0, hint: '% (Azure memory: GiB available).' },
    { id: 'minutes', label: 'For (minutes)', control: 'number', default: 15, min: 5, max: 60 },
    { id: 'severity', label: 'Severity', control: 'select', default: '2', options: [opt('0', 'Critical'), opt('1', 'Error'), opt('2', 'Warning'), opt('3', 'Informational')] },
    { id: 'emails', label: 'Notify', control: 'text', default: 'ops@corp.example.com', hint: 'Space-separated email addresses.' },
    ...NETWORK_INPUTS, RG_INPUT, ZONE_INPUT,
  ],
  build(values)                {
    const platform = platformOf(values, monitoringAlert)                               ;
    const findings            = [];
    let metric = val(values, 'metric', 'cpu')          ;
    if (!ALERT_METRICS[platform].includes(metric)) {
      findings.push(warning('change.alert.metric', `${METRIC_LABELS[metric]} is not offered on ${PLATFORM_LABELS[platform]} here: CPU is used.`, { path: 'metric' }));
      metric = 'cpu';
    }
    const server = val(values, 'server', 'app01');
    const name = safeName(`atk-${server}-${metric}`, 60);
    const emails = val(values, 'emails', 'ops@corp.example.com').split(/[\s,]+/).filter(Boolean);
    if (!emails.length) findings.push(error('change.alert.no-target', 'Name at least one email to notify.', { path: 'emails' }));
    const threshold = numVal(values, 'threshold', 90);
    const tf = alertTf(platform, metric, threshold, name, emails, values);
    return {
      platform, target: server, route: 'terraform', summary: `Alert when ${METRIC_LABELS[metric]} on ${server} passes ${threshold} (${PLATFORM_LABELS[platform]})`,
      files: tfRoot({ platform, header: `A ${metric} alert on the server named in var.server.`, main: tf.main, variables: tf.vars }), findings,
      apply: [{ kind: 'terraform', title: `Create the ${metric} alert on ${server}`, dir: 'terraform', lz: true }],
      rollback: [{ kind: 'terraform-destroy', title: 'Delete the alert', dir: 'terraform', lz: true }],
      needs: [],
      notes: ['Email subscriptions are confirmed from the email each address receives.', 'VCF: alerts are VCF Operations alert definitions (the VCF Operations pages), so this utility does not offer VCF.'],
    };
  },
};

export const GOVERNANCE_UTILITIES                           = [tags, budget, monitoringAlert];

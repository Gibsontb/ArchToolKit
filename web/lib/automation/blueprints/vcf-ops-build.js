/**
 * VCF Operations 9.1: building the content people look at, and the things it
 * is extended with.
 *
 * The other VCF Operations blueprints write what an automation stands on — the
 * alert, the policy, the schedule. This set writes what a person opens: the
 * dashboard, the view behind it, the report built from the views and
 * dashboards. And the ways VCF Operations is extended in 9.1: a management pack
 * someone else wrote, one built in Management Pack Builder (which now reads
 * Prometheus), the orchestrator's Python and PowerShell workflows, application
 * monitoring with Telegraf through a cloud proxy, and HCX, checked and taken
 * through its lifecycle.
 *
 * Dashboards come out in the same JSON the VCF Ops content page reads — a
 * `dashboards` array, widgets placed by `gridsterCoords` on a 12-column grid —
 * so a dashboard written here can be dropped back onto that page and checked
 * like any other.
 *
 * The second export is VCF Operations for Networks 9.1: VPC planning, the
 * migration-wave generator, the assessment report and the admin health view.
 */

import { bool, num, str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint,                          } from '../from-automation.js';
import { listOf, slugOf,                 } from '../automation.js';
import { authHeader, authPreamble, readScript } from '../apply.js';
import { networksPreamble, networksScheduledEnv } from './vcf-networks-logs.js';
import { authFileVar, workDirLines } from './vcf-operations-content.js';
import { CSV_COLUMNS } from '../../migration/portfolio.js';
import { familyOf, formatHostPort, isIp, isIpv6, overlapsAny, splitHostPort } from '../../core/ip.js';
import { Entries, Settings, WIDGET_TYPES, catalogueHelp, metricKeyProblem, parseKind, settingProblems, widgetType,                                                   } from './vcf-ops-widgets.js';
import {
  CONTENT_ZIP,
  DASHBOARD_OWNER_PLACEHOLDER,
  FORMAT_SOURCES,
  contentImportScript,
  contentPackage,
  contentStep,
  importMd,
  nothingToImportMd,
  stableId,
} from '../vcfops-import.js';

const PLATFORM = 'vcf-operations'         ;
const NETWORKS = 'vcf-operations-networks'         ;
const SRC = 'ArchToolKit';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A header for a token that is not one of the apply.ts targets (the
 * orchestrator's Bearer, HCX's x-hm-authorization, the Networks token), written
 * the way authPreamble writes its own: a file only this user can read, removed
 * on exit, and passed to curl as -H @file so the token is never an argument.
 * The trap also removes the VCF Operations header file, in case the script has
 * one: a second trap on EXIT replaces the first.
 */
function privateHeader(fileVar        , prefix        , tokenVar        )           {
  return [
    `${fileVar}="$(umask 077; mktemp "\${TMPDIR:-/tmp}/auth.XXXXXX")"`,
    `trap 'rm -f "$${fileVar}" "\${${authFileVar(PLATFORM)}:-}"' EXIT`,
    `printf '%s %s\n' '${prefix}' "$${tokenVar}" > "$${fileVar}"`,
  ];
}

/** Escape for a bash single-quoted string. */
function sq(text        )         {
  return text.replace(/'/g, "'\\''");
}

function xml(text        )         {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function csvCell(value                 )         {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Name-derived ids (see vcfops-import.ts), re-exported for the blueprints that already use them from here. */
export { stableId };

const viewIdOf = (name        )         => stableId(`view:${name}`);

const CONTENT_IMPORT_NOTE =
  'Content import: POST /suite-api/api/content/operations/import (multipart contentFile) answers 202 with the new operation’s id; GET on the same path is the last import, with state NOT_INITIALIZED, INITIALIZED, RUNNING, FAILED, FINISHED or UNKNOWN and operationSummaries[] (imported, skipped, failed). The reference says "If the force option is set to true, content will be overwritten. By default the flag is true", so the script sends force=false unless --overwrite. The importer checks for the instance’s own <number>L.v1 marker file, which the script copies from the backup export it takes first.';

/** IMPORT.md's opening and sources for the dashboard and view, in VCF 9.1 names only. */
const IMPORT_INTRO = ['Each step says which file goes where, in the order they depend on each other. Menu paths are VCF Operations 9.1, with the 8.x path in brackets where it differs.'];
const CONTENT_SOURCES                    = [
  'Broadcom TechDocs, VCF Operations 9.0: "Importing Content" (Content Management) and "Widget Definitions List".',
  'Real exports: github.com/notoriousbdg (VMware’s own 8.x content: Views.zip, Dashboard.zip) and github.com/sentania-labs/vcf-content-factory-bundles (VCF Operations 9: Views.zip, Reports.zip, Dashboard.zip, content-zip installer).',
  'VCF Operations API reference: /api/content/operations/{export,import}.',
];

/** Export the same kind of content from the target, as the reference layout. */
function exportReferenceScript(contentType        )         {
  return readScript(PLATFORM, `Export existing ${contentType} content as the reference layout for an import.`, [
    ...workDirLines(PLATFORM),
    'API="https://${VCFOPS_HOST}/suite-api/api/content/operations"',
    `jq -n '{scope: "CUSTOM", contentTypes: ["${contentType}"]}' | curl -sS -f -X POST "$API/export" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @- >/dev/null`,
    'state=""',
    'for _ in $(seq 1 60); do',
    '  sleep 5',
    `  state=$(curl -sS -f "$API/export" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" | jq -r '.state // "UNKNOWN"') || continue`,
    '  case "$state" in FINISHED|FAILED) break ;; esac',
    'done',
    '[[ "$state" == FINISHED ]] || { echo "The export did not finish (state: ${state:-none})." >&2; exit 1; }',
    `curl -sS -f "$API/export/zip" -H "${authHeader(PLATFORM)}" -o reference-export.zip`,
    'unzip -l reference-export.zip',
    'echo "Compare this layout with the zip the import script builds before importing."',
  ]);
}

// ---------------------------------------------------------------------------
// Dashboards and views: the templates
// ---------------------------------------------------------------------------

/** A column's transformation, as the attributes-selector writes it (`transformations` list). */
                                                                                                                        

                      
                       
                         
                              
                                       
                                 
                               
                               
                                                                            
                         
                                                                                                 
                          
                                                                                             
                                                                                              
                                                     
                          
                                                                    
                                
 

                                                                                     

                        
                        
                                                                                       
                        
                                      
                                          
                                                                                         
                          
 

/** One condition of a SubjectType filter (the JSON in its filter= attribute). */
                            
                                                
                       
                             
                                  
 

/** Everything about a view that is not its columns. */
                       
                               
                                        
                                                                                                                                                              
                                                    
                                     
                                                                                                                                                                      
                            
                                             
                        
                            
                                                            
                                                                                                                                                                                                                      
                                                                                                          
                                               
                        
 

/** The placeholder an image view carries until embed-image.sh writes the picture in. */
const IMAGE_PLACEHOLDER = '<REQUIRED: IMAGE_BASE64 set by embed-image.sh>';

/**
 * A standard dashboard, as the rows of the widget grid it starts from.
 *
 * Picking a template shows its own grid, filled in; the rows are then the
 * user's to change. A template with a view names it after itself, and the view
 * blueprint writes that view under the same name, so the id matches.
 */
                             
                         
                         
                                                        
                         
                                                                       
                                                                                        
                                                                             
                            
 

const about = (text        )                                                   => ['TextDisplay', 'About this dashboard', `text=${text}`, '1,1,12,2', 'no', ''];

const DASHBOARD_TEMPLATES                               = [
  {
    value: 'capacity',
    label: 'Cluster capacity overview',
    about: 'What capacity each cluster has left, how long it lasts, and which cluster runs out first.',
    hasView: true,
    rows: [
      about('Cluster capacity: what is left, how long it lasts, and which cluster runs out first. Select a cluster on the left.'),
      ['ResourceList', 'Clusters', 'kinds=cluster; columns=OnlineCapacityAnalytics|capacityRemainingPercentage,OnlineCapacityAnalytics|timeRemaining', '1,3,4,6', 'yes', ''],
      ['Scoreboard', 'Capacity remaining', 'kind=cluster; metrics=OnlineCapacityAnalytics|capacityRemainingPercentage,OnlineCapacityAnalytics|timeRemaining; labels=Capacity remaining %,Time remaining (days)', '5,3,4,6', 'no', 'Clusters'],
      ['ParetoAnalysis', 'Least time remaining', 'kind=cluster; metric=OnlineCapacityAnalytics|timeRemaining; top=10; order=lowest; label=Time remaining (days)', '9,3,4,6', 'yes', ''],
      ['View', 'Cluster capacity', 'view=Cluster capacity overview', '1,9,12,6', 'no', 'Clusters'],
      ['Heatmap', 'CPU demand by cluster', 'kind=host; groupby=cluster; sizeby=cpu|demandmhz; colorby=cpu|demandPct; values=0,70,90; colors=#8ABF5B,#EACC58,#E4695E', '1,15,6,6', 'yes', ''],
      ['HealthChart', 'CPU demand trend', 'kind=cluster; metric=cpu|demandPct; mode=self; thresholds=70,85,95; period=last7Days', '7,15,6,6', 'no', 'Clusters'],
    ],
  },
  {
    value: 'tier1',
    label: 'Tier 1 application health',
    about: 'Every VM in the Tier 1 custom group, its health, its performance right now and its alerts.',
    hasView: true,
    rows: [
      about('Tier 1 applications: every VM in the custom group "Tier 1 Applications". Select one on the left; everything else follows it.'),
      ['ResourceList', 'Tier 1 VMs', 'kinds=vm; group=Tier 1 Applications; grouptype=Environment', '1,3,4,8', 'yes', ''],
      ['HealthChart', 'Health, last 24 hours', 'kind=vm; metric=badge|health; mode=self; period=last24Hour', '5,3,8,4', 'no', 'Tier 1 VMs'],
      ['Scoreboard', 'Right now', 'kind=vm; metrics=cpu|readyPct,mem|guest_usage,virtualDisk|totalLatency; labels=CPU ready %,Guest memory %,Disk latency (ms)', '5,7,4,4', 'no', 'Tier 1 VMs'],
      ['ProblemAlertsList', 'Top alerts', 'badge=all; objects=self; limit=5', '9,7,4,4', 'no', 'Tier 1 VMs'],
      ['View', 'Tier 1 detail', 'view=Tier 1 application health', '1,11,12,6', 'no', 'Tier 1 VMs'],
    ],
  },
  {
    value: 'tags',
    label: 'Tag compliance',
    about: 'VMs missing a required vSphere tag category, by cluster.',
    hasView: true,
    rows: [
      about('Tag compliance: VMs missing any of the required tag categories (Owner, Environment, CostCentre). An untagged VM is one no automation can scope correctly.'),
      ['ResourceList', 'Clusters', 'kinds=cluster', '1,3,4,6', 'yes', ''],
      ['View', 'VMs and their tags', 'view=Tag compliance; first=yes', '5,3,8,6', 'no', 'Clusters'],
      ['PropertyList', 'The selected VM', 'kind=vm; props=summary|tag,summary|parentCluster,summary|runtime|powerState; labels=vSphere tags,Cluster,Power state', '1,9,6,5', 'no', 'VMs and their tags'],
      ['AlertList', 'Compliance alerts', 'kinds=vm; types=compliance,configuration; world=yes', '7,9,6,5', 'no', ''],
    ],
  },
  {
    value: 'reclaim',
    label: 'Reclamation',
    about: 'Powered-off VMs, idle VMs and snapshot space, largest first.',
    hasView: true,
    rows: [
      about('Reclamation: powered-off VMs, idle VMs and snapshot space, largest first. Review here; reclaim with the scheduled reclamation automation, not by hand from this page.'),
      ['ParetoAnalysis', 'Largest snapshots', 'kind=vm; metric=diskspace|snapshot; top=10; order=highest; label=Snapshot space (GB)', '1,3,4,6', 'yes', ''],
      ['ParetoAnalysis', 'Most idle', 'kind=vm; metric=cpu|usage_average; top=10; order=lowest; label=CPU usage %', '5,3,4,6', 'yes', ''],
      ['Scoreboard', 'Reclaimable by cluster', 'kind=cluster; metrics=OnlineCapacityAnalytics|reclaimableCapacity; labels=Reclaimable capacity; names=yes', '9,3,4,6', 'yes', ''],
      ['View', 'Reclamation candidates', 'view=Reclamation', '1,9,12,8', 'yes', ''],
    ],
  },
  {
    value: 'certs',
    label: 'Fleet certificate expiry',
    about: 'Certificate alerts across the fleet, and the vCenter certificates that expire first.',
    hasView: true,
    rows: [
      about('Fleet certificates: expiry is tracked in Fleet Management > Certificates in VCF 9.1. This dashboard shows the alerts raised from it; renew with the fleet certificate automation.'),
      ['AlertList', 'Certificate and configuration alerts', 'kinds=vcenter,host; types=configuration,availability; world=yes', '1,3,12,6', 'no', ''],
      ['View', 'vCenter certificate expiry', 'view=Fleet certificate expiry', '1,9,12,6', 'yes', ''],
    ],
  },
  {
    value: 'host_health',
    label: 'ESX host health',
    about: 'Every ESX host, its health, its top alerts, its CPU and memory, and where it sits.',
    hasView: true,
    rows: [
      about('ESX host health: select a host on the left to see its health, top alerts and load. The heat map shows every host by cluster.'),
      ['ResourceList', 'Hosts', 'kinds=host; columns=badge|health,cpu|usage_average,mem|usage_average', '1,3,5,8', 'yes', ''],
      ['ScoreboardHealth', 'Health of the selected host', 'badge=health', '6,3,3,4', 'no', 'Hosts'],
      ['ProblemAlertsList', 'Top alerts on the host', 'badge=health; objects=selfChildren; limit=10', '9,3,4,4', 'no', 'Hosts'],
      ['MetricChart', 'CPU and memory', 'kind=host; metrics=cpu|usage_average,mem|usage_average; labels=CPU %,Memory %', '6,7,7,4', 'no', 'Hosts'],
      ['Heatmap', 'Host health by cluster', 'kind=host; groupby=cluster; colorby=badge|health; values=0,25,75,100; colors=#E4695E,#ED891F,#EACC58,#8ABF5B', '1,11,6,6', 'yes', ''],
      ['ResourceRelationshipAdvanced', 'Where it sits', 'depth=2,1', '7,11,6,6', 'no', 'Hosts'],
      ['View', 'Hosts in detail', 'view=ESX host health', '1,17,12,6', 'yes', ''],
    ],
  },
  {
    value: 'vm_perf',
    label: 'VM performance',
    about: 'CPU ready, memory, disk latency and network for any VM, with the worst ones ranked.',
    hasView: true,
    rows: [
      ['ParetoAnalysis', 'Highest CPU ready', 'kind=vm; metric=cpu|readyPct; top=10; order=highest; label=CPU ready %; thresholds=2.5,5,10', '1,1,4,6', 'yes', ''],
      ['ResourceList', 'VMs', 'kinds=vm; columns=cpu|readyPct,mem|guest_usage,virtualDisk|totalLatency', '5,1,8,6', 'yes', ''],
      ['MetricChart', 'CPU ready and usage', 'kind=vm; metrics=cpu|readyPct,cpu|usage_average; labels=CPU ready %,CPU usage %', '1,7,6,5', 'no', 'VMs'],
      ['SparklineChart', 'Disk and network', 'kind=vm; metrics=virtualDisk|totalLatency,disk|read_average,net|received_average; labels=Disk latency (ms),Disk read (KBps),Network receive (KBps)', '7,7,6,5', 'no', 'VMs'],
      ['Scoreboard', 'Right now', 'kind=vm; metrics=cpu|readyPct,mem|guest_usage,virtualDisk|totalLatency; labels=CPU ready %,Guest memory %,Disk latency (ms); sparkline=yes; period=last24Hour', '1,12,6,4', 'no', 'VMs'],
      ['ProblemAlertsList', 'Top alerts on the VM', 'badge=all; objects=self; limit=5', '7,12,6,4', 'no', 'VMs'],
      ['View', 'All VMs', 'view=VM performance', '1,16,12,6', 'yes', ''],
    ],
  },
  {
    value: 'datastore',
    label: 'Datastore and vSAN capacity',
    about: 'The fullest datastores, their growth, their time remaining, and vSAN cluster capacity.',
    hasView: true,
    rows: [
      ['ParetoAnalysis', 'Fullest datastores', 'kind=datastore; metric=capacity|usedSpacePct; top=10; order=highest; label=Used space %; thresholds=75,85,95', '1,1,4,6', 'yes', ''],
      ['ResourceList', 'Datastores', 'kinds=datastore; columns=capacity|usedSpacePct,OnlineCapacityAnalytics|timeRemaining', '5,1,8,6', 'yes', ''],
      ['HealthChart', 'Used space trend', 'kind=datastore; metric=capacity|usedSpacePct; mode=self; period=last30Days; thresholds=75,85,95', '1,7,6,5', 'no', 'Datastores'],
      ['Scoreboard', 'Time and capacity remaining', 'kind=datastore; metrics=OnlineCapacityAnalytics|timeRemaining,OnlineCapacityAnalytics|capacityRemainingPercentage; labels=Time remaining (days),Capacity remaining %', '7,7,6,5', 'no', 'Datastores'],
      ['Heatmap', 'vSAN clusters by capacity remaining', 'kind=vsan-cluster; colorby=OnlineCapacityAnalytics|capacityRemainingPercentage; values=0,10,20,100; colors=#E4695E,#ED891F,#EACC58,#8ABF5B', '1,12,6,6', 'yes', ''],
      ['View', 'Every datastore', 'view=Datastore and vSAN capacity', '7,12,6,6', 'yes', ''],
    ],
  },
  {
    value: 'nsx',
    label: 'NSX health',
    about: 'NSX Managers, transport nodes, their health and alerts.',
    hasView: false,
    rows: [
      about('NSX health: select an NSX Manager to see its transport nodes, then a node to see its health and where it connects.'),
      ['ResourceList', 'NSX Managers', 'kinds=nsx-manager', '1,3,4,5', 'yes', ''],
      ['ResourceList', 'Transport nodes', 'kinds=nsx-node; columns=badge|health', '5,3,4,5', 'no', 'NSX Managers'],
      ['ProblemAlertsList', 'Top NSX alerts', 'badge=all; objects=selfChildren; limit=10; pin=nsx-world', '9,3,4,5', 'yes', ''],
      ['HealthChart', 'Transport node health', 'kind=nsx-node; metric=badge|health; mode=self; period=last24Hour', '1,8,6,5', 'no', 'Transport nodes'],
      ['ResourceRelationshipAdvanced', 'Where it connects', 'kinds=nsx-node,host; depth=1,2', '7,8,6,5', 'no', 'Transport nodes'],
      ['AlertList', 'NSX alerts', 'kinds=nsx-node,nsx-manager; world=yes', '1,13,12,5', 'no', ''],
    ],
  },
  {
    value: 'vks',
    label: 'VKS and Kubernetes',
    about: 'Supervisor namespaces, the VKS clusters in them, their load and their alerts.',
    hasView: true,
    rows: [
      ['ResourceList', 'Supervisor namespaces', 'kinds=namespace', '1,1,4,6', 'yes', ''],
      ['ResourceList', 'VKS clusters', 'kinds=vks', '5,1,4,6', 'no', 'Supervisor namespaces'],
      ['ScoreboardHealth', 'Namespace health', 'badge=health', '9,1,4,3', 'no', 'Supervisor namespaces'],
      ['ProblemAlertsList', 'Top alerts', 'badge=all; objects=selfChildren; limit=5', '9,4,4,3', 'no', 'Supervisor namespaces'],
      ['MetricChart', 'Namespace CPU and memory', 'kind=namespace; metrics=cpu|usagemhz_average,mem|usage_average; labels=CPU (MHz),Memory %', '1,7,6,5', 'no', 'Supervisor namespaces'],
      ['ResourceRelationshipAdvanced', 'What runs in it', 'depth=0,2', '7,7,6,5', 'no', 'VKS clusters'],
      ['View', 'Every VKS cluster', 'view=VKS and Kubernetes', '1,12,12,6', 'yes', ''],
    ],
  },
  {
    value: 'alerts',
    label: 'Alerts overview',
    about: 'Alert volume, health, the top alerts and every critical or immediate alert, with the object behind it.',
    hasView: false,
    rows: [
      ['IntSummaryAlertVolume', 'Alert volume', '', '1,1,4,4', 'yes', ''],
      ['IntSummaryHealth', 'Health of the environment', 'badge=yes', '5,1,4,4', 'yes', ''],
      ['ProblemAlertsList', 'Top health alerts', 'badge=health; objects=selfChildren; limit=10', '9,1,4,4', 'yes', ''],
      ['AlertList', 'Critical and immediate alerts', 'criticality=critical,immediate; status=active; world=yes', '1,5,12,6', 'no', ''],
      ['ResourceRelationshipAdvanced', 'Object behind the alert', 'depth=2,1; first=yes', '1,11,6,6', 'no', 'Critical and immediate alerts'],
      ['MetricPicker', 'Its metrics', '', '7,11,6,6', 'no', 'Object behind the alert'],
    ],
  },
  {
    value: 'cost',
    label: 'Cost overview',
    about: 'What each cluster costs, its CPU and memory rates, and the most expensive VMs and clusters.',
    hasView: true,
    rows: [
      about('Cost: the monthly cost of each cluster and VM as VCF Operations calculates it from the cost drivers. Select a cluster to see its VMs.'),
      ['ResourceList', 'Clusters', 'kinds=cluster; columns=cost|totalCost,cost|cpuBaseRate,cost|memoryBaseRate', '1,3,6,6', 'yes', ''],
      ['Scoreboard', 'Cluster cost this month', 'kind=cluster; metrics=cost|totalCost,cost|totalCpuCost,cost|totalMemoryCost; labels=Total,CPU,Memory; decimals=0', '7,3,6,6', 'no', 'Clusters'],
      ['ParetoAnalysis', 'Most expensive VMs', 'kind=vm; metric=cost|monthlyTotalCost; top=15; order=highest; label=Monthly total cost', '1,9,6,6', 'yes', ''],
      ['ParetoAnalysis', 'Most expensive clusters', 'kind=cluster; metric=cost|totalCost; top=10; order=highest; label=Monthly total cost', '7,9,6,6', 'yes', ''],
      ['View', 'VM cost', 'view=Cost overview', '1,15,12,6', 'no', 'Clusters'],
    ],
  },
  {
    value: 'compliance',
    label: 'Compliance',
    about: 'Compliance alerts from the benchmarks enabled in policy, the objects behind them, and risk by host.',
    hasView: false,
    rows: [
      about('Compliance: alerts raised by the compliance benchmarks enabled in the active policy. Select an alert to see the object it is on.'),
      ['AlertList', 'Compliance alerts', 'types=compliance; criticality=warning,immediate,critical; world=yes', '1,3,12,6', 'no', ''],
      ['ResourceRelationshipAdvanced', 'Object behind the alert', 'depth=2,1; first=yes', '1,9,6,6', 'no', 'Compliance alerts'],
      ['ProblemAlertsList', 'Top risk alerts', 'badge=risk; objects=selfChildren; limit=10', '7,9,6,6', 'yes', ''],
      ['Heatmap', 'Hosts by risk', 'kind=host; groupby=cluster; colorby=badge|risk; values=0,25,75,100; colors=#8ABF5B,#EACC58,#ED891F,#E4695E', '1,15,12,6', 'yes', ''],
    ],
  },
  {
    value: 'home',
    label: 'Environment summary',
    about: 'Health, alert volume, capacity and time remaining for the whole environment, with the top alerts.',
    hasView: false,
    rows: [
      ['IntSummaryHealth', 'Health', 'badge=yes', '1,1,3,4', 'yes', ''],
      ['IntSummaryAlertVolume', 'Alert volume', '', '4,1,3,4', 'yes', ''],
      ['IntSummaryCapacity', 'Capacity remaining', '', '7,1,3,4', 'yes', ''],
      ['IntSummaryTimeRemaining', 'Time remaining', '', '10,1,3,4', 'yes', ''],
      ['Skittles', 'Environment overview', 'kinds=vcenter,cluster,host,vm,datastore', '1,5,6,5', 'yes', ''],
      ['ProblemAlertsList', 'Top alerts', 'badge=all; objects=selfChildren; limit=10', '7,5,6,5', 'yes', ''],
      ['Heatmap', 'Clusters by capacity remaining', 'kind=cluster; colorby=OnlineCapacityAnalytics|capacityRemainingPercentage; values=0,5,10,80; colors=#DE3F30,#ED891F,#ECC33E,#74B43B,#8D8B8D', '1,10,6,6', 'yes', ''],
      ['RecommendedActions', 'Recommended actions', '', '7,10,6,6', 'no', ''],
    ],
  },
  {
    value: 'custom',
    label: 'My own widgets',
    about: '',
    hasView: false,
    rows: [
      ['ResourceList', 'Objects', 'kinds=cluster', '1,1,4,6', 'yes', ''],
      ['MetricChart', 'Trend', 'kind=cluster; metrics=cpu|usage_average,mem|usage_average; labels=CPU %,Memory %', 'auto', 'no', 'Objects'],
      ['PropertyList', 'Details', 'kind=cluster; metrics=OnlineCapacityAnalytics|timeRemaining,summary|number_running_vms; labels=Time remaining (days),Running VMs', 'auto', 'no', 'Objects'],
    ],
  },
];

/** The templates with a view of their own: the view blueprint's starting points. */
const TEMPLATES = DASHBOARD_TEMPLATES.filter((t) => t.hasView).map((t) => ({ value: t.value, label: t.label }));

const templateOf = (value        )                    => DASHBOARD_TEMPLATES.find((t) => t.value === value) ?? DASHBOARD_TEMPLATES[0] ;
const templateName = (value        )         => templateOf(value).label;

/**
 * Object types for a view's or a report's subject, grouped by the adapter that
 * owns them. The value is the vSphere adapter's kind as it stands, or
 * "Adapter/Kind" for any other adapter (as the dashboard grid writes kinds).
 * `seen` marks the ones found as a SubjectType or column kind in a real export
 * (brockpeterson/operations_dashboards, sentania-labs/vcf-content-factory);
 * the rest are the adapters' documented kinds and are said to be unverified
 * when chosen. The field is a combo: any other kind can be typed.
 */
const KINDS                                                                                                                 = [
  { value: 'VirtualMachine', label: 'Virtual machine', group: 'vSphere', seen: true },
  { value: 'HostSystem', label: 'ESX host', group: 'vSphere', seen: true },
  { value: 'ClusterComputeResource', label: 'Cluster', group: 'vSphere', seen: true },
  { value: 'Datastore', label: 'Datastore', group: 'vSphere', seen: true },
  { value: 'StoragePod', label: 'Datastore cluster', group: 'vSphere' },
  { value: 'Datacenter', label: 'Datacenter', group: 'vSphere', seen: true },
  { value: 'VMwareAdapter Instance', label: 'vCenter', group: 'vSphere', seen: true },
  { value: 'vSphere World', label: 'vSphere World', group: 'vSphere', seen: true },
  { value: 'ResourcePool', label: 'Resource pool', group: 'vSphere' },
  { value: 'VmwareDistributedVirtualSwitch', label: 'Distributed switch', group: 'vSphere', seen: true },
  { value: 'DistributedVirtualPortgroup', label: 'Distributed port group', group: 'vSphere' },
  { value: 'Namespace', label: 'Supervisor namespace', group: 'Kubernetes and VKS' },
  { value: 'GuestCluster', label: 'VKS cluster', group: 'Kubernetes and VKS' },
  { value: 'KubernetesAdapter/K8S-Namespace', label: 'Kubernetes namespace', group: 'Kubernetes and VKS' },
  { value: 'VirtualAndPhysicalSANAdapter/VirtualSANDCCluster', label: 'vSAN cluster', group: 'vSAN' },
  { value: 'VirtualAndPhysicalSANAdapter/VirtualSANDiskGroup', label: 'vSAN disk group', group: 'vSAN' },
  { value: 'VirtualAndPhysicalSANAdapter/vSAN World', label: 'vSAN World', group: 'vSAN' },
  { value: 'NSXTAdapter/NSXTAdapterInstance', label: 'NSX Manager', group: 'NSX' },
  { value: 'NSXTAdapter/TransportNode', label: 'NSX transport node', group: 'NSX' },
  { value: 'NSXTAdapter/LogicalSwitch', label: 'NSX segment', group: 'NSX' },
  { value: 'NSXTAdapter/LogicalRouter', label: 'NSX gateway (tier-0 / tier-1)', group: 'NSX' },
  { value: 'NSXTAdapter/EdgeCluster', label: 'NSX Edge cluster', group: 'NSX' },
  { value: 'NSXTAdapter/NSXT World', label: 'NSX World', group: 'NSX' },
  { value: 'VcfAdapter/VCFWorld', label: 'VCF World', group: 'VCF' },
  { value: 'VMWARE_INFRA_HEALTH/CERTIFICATE', label: 'Certificate (infrastructure health)', group: 'VCF', seen: true },
  { value: 'VMWARE_INFRA_HEALTH/LicenseUsage', label: 'License usage', group: 'VCF', seen: true },
  { value: 'APPOSUCP/linux', label: 'Linux OS (application monitoring)', group: 'Application monitoring', seen: true },
  { value: 'APPOSUCP/win', label: 'Windows OS (application monitoring)', group: 'Application monitoring', seen: true },
];

const KIND_OPTIONS = KINDS.map((kind) => ({ value: kind.value, label: kind.label, group: kind.group }));

/** A kind as typed, with the vSphere adapter as the default. */
function kindRef(text        )          {
  return parseKind(text) ?? { adapterKind: 'VMWARE', resourceKind: 'VirtualMachine' };
}

const kindText = (kind         )         => (kind.adapterKind === 'VMWARE' ? kind.resourceKind : `${kind.adapterKind}/${kind.resourceKind}`);
const sameKind = (a         , b         )          => a.adapterKind === b.adapterKind && a.resourceKind === b.resourceKind;
const kindLabel = (kind         )         => KINDS.find((k) => sameKind(kindRef(k.value), kind))?.label ?? kindText(kind);

/** preferredUnitId values seen in real view exports (brockpeterson, sentania-labs); any other is passed through. */
const VIEW_UNITS                                                                = [
  { value: 'auto', label: 'auto' },
  { value: 'percent', label: 'percent' },
  { value: 'gb', label: 'GB' },
  { value: 'tb', label: 'TB' },
  { value: 'ghz', label: 'GHz' },
  { value: 'mhz', label: 'MHz' },
  { value: 'msec', label: 'ms' },
  { value: 'hr', label: 'hours' },
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'mbps', label: 'Mbps' },
  { value: 'kbps', label: 'KBps' },
  { value: 'wh', label: 'Wh' },
  { value: 'currency', label: 'currency' },
  { value: 'currencymonth', label: 'currency per month' },
  { value: 'vcpus', label: 'vCPUs' },
  { value: '7004', label: 'count' },
  { value: 'none', label: 'no unit' },
];

/** SubjectType filter conditions: the first four are in real exports; CONTAINS and LESS_THAN are the editor's and are said to be unverified. */
const FILTER_CONDITIONS                    = ['EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'NOT_CONTAINS', 'CONTAINS', 'LESS_THAN'];

const TRANSFORMS                                      = {
  current: 'CURRENT',
  avg: 'AVG',
  average: 'AVG',
  max: 'MAX',
  maximum: 'MAX',
  min: 'MIN',
  minimum: 'MIN',
  sum: 'SUM',
  forecast: 'FORECAST',
  first: 'FIRST',
  last: 'LAST',
  timestamp: 'TIMESTAMP',
};

/**
 * The column grid: Attribute key | Label | Transformation | Unit | Kind. The
 * key may start ancestor(Kind) or descendant(Kind) to read it from a related
 * object; the transformation may be "property", or "percentile 99". A row
 * written the old way (key | label | property) still reads.
 */
export function parseViewColumns(text        , percentile        )                                                {
  const columns               = [];
  const problems           = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    const [rawKey = '', label = '', transformText = '', unit = '', kindCell = ''] = cellsOf(line);
    let key = rawKey;
    let related                       ;
    const rel = /^(ancestor|descendant)\s*\(([^)]+)\)\s+(.+)$/i.exec(rawKey);
    if (rel) {
      related = { relation: rel[1] .toUpperCase()                             , kind: kindRef(rel[2] ) };
      key = rel[3] .trim();
    }
    if (!key) {
      problems.push(`"${line}" has no attribute key.`);
      continue;
    }
    const name = label || key;
    const t = transformText.trim().toLowerCase();
    let property = false;
    let transform            = 'CURRENT';
    let pct                    ;
    const pm = /^(?:percentile|p)\s*(\d+)?(?:th)?$/.exec(t);
    if (t === '' || t === 'current') transform = 'CURRENT';
    else if (t === 'property') property = true;
    else if (pm && t !== 'p') {
      transform = 'PERCENTILE';
      pct = pm[1] ? Number(pm[1]) : percentile;
      if (!Number.isInteger(pct) || pct < 1 || pct > 99) problems.push(`Column "${name}": percentile ${pct} is not a whole number from 1 to 99.`);
    } else if (TRANSFORMS[t]) {
      transform = TRANSFORMS[t] ;
      // A timestamp is shown for a property holding a time (config|createDate).
      if (transform === 'TIMESTAMP') property = true;
    } else {
      problems.push(`Column "${name}": "${transformText}" is not a transformation (current, avg, max, min, sum, percentile, forecast, first, last, timestamp, or property).`);
    }
    const unitValue = unit.trim();
    if (unitValue && !VIEW_UNITS.some((u) => u.value === unitValue.toLowerCase()) && !/^\d+$/.test(unitValue)) {
      problems.push(`Column "${name}": "${unitValue}" is not a unit id (${VIEW_UNITS.map((u) => u.value).join(', ')}).`);
    }
    columns.push({
      key,
      label: name,
      ...(property ? { property: true } : {}),
      ...(transform !== 'CURRENT' ? { transform } : {}),
      ...(pct !== undefined ? { percentile: pct } : {}),
      ...(unitValue ? { unit: unitValue.toLowerCase() } : {}),
      ...(kindCell.trim() ? { kind: kindRef(kindCell) } : {}),
      ...(related ? { related } : {}),
    });
  }
  return { columns, problems };
}

/** The application services Telegraf monitors here, and whether each needs an account. */
const TELEGRAF_PLUGINS                                                                                           = [
  { value: 'apache', label: 'Apache HTTPD', account: false },
  { value: 'nginx', label: 'NGINX', account: false },
  { value: 'mysql', label: 'MySQL / MariaDB', account: true },
  { value: 'postgres', label: 'PostgreSQL', account: true },
  { value: 'mssql', label: 'Microsoft SQL Server', account: true },
  { value: 'iis', label: 'Microsoft IIS', account: false },
  { value: 'ping', label: 'Ping (reachability and latency)', account: false },
  { value: 'custom', label: 'Custom script', account: false },
];

                       
                          
                          
                                                      
                               
 

/** The plugin grid: Plugin | Target | Settings (key=value; …) | Credential (environment prefix). */
export function parseTelegrafRows(text        )                                              {
  const rows                = [];
  const problems           = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    const [pluginCell = '', target = '', settingsCell = '', credential = ''] = cellsOf(line);
    const plugin = pluginCell.toLowerCase().replace(/^postgresql$/, 'postgres').replace(/^(sqlserver|sql server)$/, 'mssql').replace(/^script$/, 'custom');
    const known = TELEGRAF_PLUGINS.find((p) => p.value === plugin);
    if (!known) {
      problems.push(`"${line}": "${pluginCell}" is not one of ${TELEGRAF_PLUGINS.map((p) => p.value).join(', ')}.`);
      continue;
    }
    if (!target) {
      problems.push(`"${line}": a ${known.label} row needs a target.`);
      continue;
    }
    const settings                         = {};
    for (const pair of settingsCell.split(';').map((p) => p.trim()).filter(Boolean)) {
      const at = pair.indexOf('=');
      if (at <= 0) problems.push(`"${line}": setting "${pair}" is not key=value.`);
      else settings[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
    }
    if (Object.keys(settings).some((key) => /pass|secret|token/i.test(key))) problems.push(`"${line}": a secret goes in the environment (the Credential cell), not in Settings.`);
    const cred = credential.trim().toUpperCase();
    if (cred && !/^[A-Z][A-Z0-9_]*$/.test(cred)) problems.push(`"${line}": "${credential}" is not an environment variable prefix (MYSQL).`);
    if (known.account && !cred) problems.push(`"${line}": ${known.label} needs an account: name its environment prefix in the Credential cell (MYSQL reads MYSQL_PASSWORD).`);
    if (plugin === 'custom' && !target.startsWith('/') && !/^[A-Za-z]:\\/.test(target)) problems.push(`"${line}": a custom script is given by its full path.`);
    if ((plugin === 'apache' || plugin === 'nginx') && /^http:\/\//i.test(target) === false && /^https?:/i.test(target) === false && /\s/.test(target)) problems.push(`"${line}": "${target}" is not a host or URL.`);
    rows.push({ plugin, target, settings, ...(cred ? { credential: cred } : {}) });
  }
  return { rows, problems };
}

/** host or host:port or [v6]:port, as host and port. */
function hostPort(target        , port        )                                                   {
  const split = splitHostPort(target.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''));
  const host = split.host || target;
  const p = split.port ?? port;
  return { host, port: p, hostPort: formatHostPort(host, p) };
}

/** One open-source Telegraf input, as TOML. Accounts are ${PREFIX_USER} / ${PREFIX_PASSWORD}. */
function telegrafInput(row             , interval        )           {
  const s = row.settings;
  const user = s.user ?? (row.credential ? `\${${row.credential}_USER}` : '');
  const pass = row.credential ? `\${${row.credential}_PASSWORD}` : '';
  const q = (text        )         => JSON.stringify(text);
  const url = (defaultPath        )         => (/^https?:\/\//i.test(row.target) ? row.target : `http://${hostPort(row.target, 80).hostPort}${s.status_path ?? defaultPath}`);
  switch (row.plugin) {
    case 'apache':
      return ['[[inputs.apache]]', `  urls = [${q(url('/server-status?auto'))}]`, `  interval = "${interval}s"`];
    case 'nginx':
      return ['[[inputs.nginx]]', `  urls = [${q(url('/nginx_status'))}]`, `  interval = "${interval}s"`];
    case 'mysql': {
      const hp = hostPort(row.target, 3306);
      return ['[[inputs.mysql]]', `  servers = [${q(`${user}:${pass}@tcp(${hp.hostPort})/?tls=${s.tls ?? 'preferred'}`)}]`, '  gather_process_list = true', `  interval = "${interval}s"`];
    }
    case 'postgres': {
      const hp = hostPort(row.target, 5432);
      return ['[[inputs.postgresql]]', `  address = ${q(`host=${hp.host} port=${hp.port} user=${user} password=${pass} dbname=${s.dbname ?? 'postgres'} sslmode=${s.sslmode ?? 'require'}`)}`, `  interval = "${interval}s"`];
    }
    case 'mssql': {
      const hp = hostPort(row.target, Number(s.port ?? 1433));
      return ['[[inputs.sqlserver]]', `  servers = [${q(`Server=${hp.host};Port=${hp.port};User Id=${user};Password=${pass};app name=telegraf;log=1;`)}]`, '  database_type = "SQLServer"', `  interval = "${interval}s"`];
    }
    case 'iis':
      return [
        '[[inputs.win_perf_counters]]',
        `  interval = "${interval}s"`,
        '  [[inputs.win_perf_counters.object]]',
        '    ObjectName = "Web Service"',
        '    Instances = ["*"]',
        '    Counters = ["Current Connections", "Bytes Received/sec", "Bytes Sent/sec", "Get Requests/sec", "Post Requests/sec"]',
        '    Measurement = "win_websvc"',
        '  [[inputs.win_perf_counters.object]]',
        '    ObjectName = "APP_POOL_WAS"',
        '    Instances = ["*"]',
        '    Counters = ["Current Application Pool State", "Total Worker Process Failures"]',
        '    Measurement = "win_apppool"',
      ];
    case 'ping': {
      const host = row.target.replace(/^\[|\]$/g, '');
      return ['[[inputs.ping]]', `  urls = [${q(host)}]`, `  count = ${Number(s.count ?? 3) || 3}`, ...(isIpv6(host) ? ['  ipv6 = true'] : []), `  interval = "${interval}s"`];
    }
    default:
      return ['[[inputs.exec]]', `  commands = [${q(row.target)}]`, `  timeout = "${s.timeout ?? '30s'}"`, `  data_format = "${s.data_format ?? 'influx'}"`, `  interval = "${interval}s"`];
  }
}

/** One report section: a view or a dashboard, by name or by id. */
                         
                                      
                        
                      
                         
                               
                             
 

/** The report content grid: Type | Name | Orientation | Colour list cells. A bare line is a view name. */
export function parseReportContent(text        , orientation        )                                                {
  const rows                  = [];
  const problems           = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    const cells = line.includes(' | ') ? cellsOf(line) : ['view', line];
    const [typeCell = '', nameCell = '', orientCell = '', colorCell = ''] = cells;
    const type = /^dash/i.test(typeCell) ? 'Dashboard' : /^view/i.test(typeCell) ? 'View' : undefined;
    if (!type || !nameCell) {
      problems.push(`"${line}" is not Type | Name | Orientation | Colour list cells, with type view or dashboard.`);
      continue;
    }
    const byId = /^id:/i.test(nameCell);
    const id = byId ? nameCell.slice(3).trim() : type === 'View' ? viewIdOf(nameCell) : stableId(`dashboard:${nameCell}`);
    const orient = orientCell ? (/^p/i.test(orientCell) ? 'Portrait' : /^l/i.test(orientCell) ? 'Landscape' : '') : orientation;
    if (!orient) problems.push(`"${line}": orientation "${orientCell}" is not Landscape or Portrait.`);
    if (byId && !/^[0-9a-f-]{8,}$/i.test(id)) problems.push(`"${line}": "${id}" does not look like a content id.`);
    rows.push({ type, name: byId ? id : nameCell, id, byId, orientation: orient || orientation, colorize: !/^(no|n|false|off)$/i.test(colorCell) });
  }
  return { rows, problems };
}

/**
 * embed-image.sh: writes a picture, as base64, over the placeholder an image
 * view carries, in every copy of the view in the download (the bare XML, the
 * view zip and the content package, each a zip or a folder of the same name).
 */
function embedImageScript()         {
  return [
    '#!/usr/bin/env bash',
    '# Write a picture into the image view, as base64, in every copy of the view in',
    `# this folder: import/view.xml, import/view.zip and ${CONTENT_ZIP}.`,
    '# Run it once, before import-view.sh, which refuses while the placeholder is there.',
    '#',
    '#   ./embed-image.sh picture.png',
    'set -euo pipefail',
    'IMG="${1:?usage: ./embed-image.sh picture.png}"',
    '[[ -f "$IMG" ]] || { echo "No such file: $IMG" >&2; exit 2; }',
    'case "$(printf \'%s\' "${IMG##*.}" | tr \'[:upper:]\' \'[:lower:]\')" in png|jpg|jpeg|gif) ;; *) echo "Give a PNG, JPEG or GIF." >&2; exit 2 ;; esac',
    'SIZE=$(wc -c < "$IMG")',
    '(( SIZE <= 2097152 )) || { echo "The picture is ${SIZE} bytes. Keep it under 2 MB: every dashboard and report that shows the view carries it." >&2; exit 2; }',
    'for tool in base64 awk zip unzip; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
    'HERE=$(cd "$(dirname "$0")" && pwd)',
    'WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/image.XXXXXX")',
    "trap 'rm -rf \"$WORK\"' EXIT",
    'base64 < "$IMG" | tr -d \'\\n\\r\' > "$WORK/b64"',
    `PLACEHOLDER='${xml(IMAGE_PLACEHOLDER)}'`,
    '# put FILE: the placeholder in FILE replaced by the picture (read from a file, so',
    '# the base64 is never an argument).',
    'put() {',
    '  awk -v f="$WORK/b64" -v p="$PLACEHOLDER" \'BEGIN { getline b < f } { while ((i = index($0, p)) > 0) $0 = substr($0, 1, i - 1) b substr($0, i + length(p)); print }\' "$1" > "$1.new"',
    '  mv "$1.new" "$1"',
    '}',
    '# inzip ZIP INNER: the same, inside ZIP — a zip, or the folder of the same name.',
    'inzip() {',
    '  local zip="$1" inner="$2" dir',
    '  if [[ -d "$zip" ]]; then put "$zip/$inner"; return; fi',
    '  [[ -f "$zip" ]] || { echo "Missing $zip — run this from the unzipped download." >&2; exit 2; }',
    '  dir=$(mktemp -d "$WORK/z.XXXXXX")',
    '  unzip -q "$zip" -d "$dir"',
    '  put "$dir/$inner"',
    '  (cd "$dir" && zip -qr - .) > "$zip"',
    '}',
    'put "$HERE/import/view.xml"',
    'inzip "$HERE/import/view.zip" content.xml',
    `PKG="$HERE/${CONTENT_ZIP}"`,
    'if [[ -d "$PKG" ]]; then',
    '  inzip "$PKG/views.zip" content.xml',
    'else',
    '  [[ -f "$PKG" ]] || { echo "Missing $PKG — run this from the unzipped download." >&2; exit 2; }',
    '  D=$(mktemp -d "$WORK/p.XXXXXX")',
    '  unzip -q "$PKG" -d "$D"',
    '  inzip "$D/views.zip" content.xml',
    '  (cd "$D" && zip -qr - .) > "$PKG"',
    'fi',
    'if grep -q "IMAGE_BASE64" "$HERE/import/view.xml"; then echo "The placeholder is still in import/view.xml." >&2; exit 1; fi',
    'echo "The picture is in the view. Next: ./import-view.sh --dry-run, then ./import-view.sh."',
    '',
  ].join('\n');
}

/**
 * The view behind each dashboard template.
 *
 * Metric keys are the VMware adapter's. `summary|tag` is the property that
 * carries a VM's vSphere tags as text; its exact key and value format vary
 * between releases, so the tag views say VERIFY.
 */
function viewTemplate(template        , tagCategories                   )               {
  switch (template) {
    case 'tier1':
      return {
        name: templateName(template),
        kind: 'VirtualMachine',
        presentation: 'list',
        columns: [
          { key: 'badge|health', label: 'Health' },
          { key: 'cpu|readyPct', label: 'CPU ready %' },
          { key: 'mem|guest_usage', label: 'Guest memory %' },
          { key: 'virtualDisk|totalLatency', label: 'Disk latency (ms)' },
          { key: 'summary|parentHost', label: 'Host', property: true },
        ],
        filter: 'Members of the Tier 1 custom group (set on the dashboard, not the view)',
      };
    case 'tags':
      return {
        name: templateName(template),
        kind: 'VirtualMachine',
        presentation: 'list',
        columns: [
          { key: 'summary|tag', label: 'vSphere tags', property: true },
          ...tagCategories.map((category) => ({ key: 'summary|tag', label: `Has ${category}`, property: true })),
          { key: 'summary|parentCluster', label: 'Cluster', property: true },
          { key: 'summary|runtime|powerState', label: 'Power state', property: true },
        ],
        filter: tagCategories.length > 0 ? `summary|tag does not contain any of: ${tagCategories.join(', ')}` : 'none',
      };
    case 'reclaim':
      return {
        name: templateName(template),
        kind: 'VirtualMachine',
        presentation: 'list',
        columns: [
          { key: 'summary|runtime|powerState', label: 'Power state', property: true },
          { key: 'cpu|usage_average', label: 'CPU usage %' },
          { key: 'diskspace|snapshot', label: 'Snapshot space (GB)' },
          { key: 'config|hardware|num_Cpu', label: 'vCPU', property: true },
          { key: 'config|hardware|memoryKB', label: 'Memory (KB)', property: true },
        ],
        filter: 'Powered off, idle, or holding snapshot space',
      };
    case 'certs':
      return {
        name: templateName(template),
        // The infrastructure-health adapter's certificate objects, with the
        // CERTIFICATE_INFO properties a real export lists (brockpeterson,
        // "vCenter Certs (from VIH)"), soonest expiry first.
        kind: 'VMWARE_INFRA_HEALTH/CERTIFICATE',
        presentation: 'list',
        columns: [
          { key: 'CERTIFICATE_INFO|NO_OF_DAYS_TO_EXPIRE', label: 'Days to expiry', property: true, sort: true },
          { key: 'CERTIFICATE_INFO|APP_HOST', label: 'Appliance host', property: true },
          { key: 'CERTIFICATE_INFO|APPLIANCE_TYPE', label: 'Appliance type', property: true },
          { key: 'CERTIFICATE_INFO|CERTIFICATE_TYPE', label: 'Certificate type', property: true },
          { key: 'CERTIFICATE_INFO|END_DATE', label: 'Expires', property: true },
        ],
        filter: 'none',
      };
    case 'host_health':
      return {
        name: templateName(template),
        kind: 'HostSystem',
        presentation: 'list',
        columns: [
          { key: 'badge|health', label: 'Health' },
          { key: 'cpu|usage_average', label: 'CPU usage %' },
          { key: 'mem|usage_average', label: 'Memory usage %' },
          { key: 'cpu|capacity_contentionPct', label: 'CPU contention %' },
          { key: 'summary|number_running_vms', label: 'Running VMs' },
          { key: 'summary|parentCluster', label: 'Cluster', property: true },
        ],
        filter: 'none',
      };
    case 'vm_perf':
      return {
        name: templateName(template),
        kind: 'VirtualMachine',
        presentation: 'list',
        columns: [
          { key: 'cpu|readyPct', label: 'CPU ready %' },
          { key: 'cpu|usage_average', label: 'CPU usage %' },
          { key: 'mem|guest_usage', label: 'Guest memory %' },
          { key: 'virtualDisk|totalLatency', label: 'Disk latency (ms)' },
          { key: 'net|usage_average', label: 'Network (KBps)' },
          { key: 'summary|parentHost', label: 'Host', property: true },
        ],
        filter: 'none',
      };
    case 'datastore':
      return {
        name: templateName(template),
        kind: 'Datastore',
        presentation: 'list',
        columns: [
          { key: 'capacity|usedSpacePct', label: 'Used space %' },
          { key: 'OnlineCapacityAnalytics|capacityRemainingPercentage', label: 'Capacity remaining %' },
          { key: 'OnlineCapacityAnalytics|timeRemaining', label: 'Time remaining (days)' },
          { key: 'summary|type', label: 'Type', property: true },
        ],
        filter: 'none',
      };
    case 'vks':
      return {
        name: templateName(template),
        kind: 'GuestCluster',
        presentation: 'list',
        columns: [
          { key: 'badge|health', label: 'Health' },
          { key: 'cpu|usagemhz_average', label: 'CPU (MHz)' },
          { key: 'mem|usage_average', label: 'Memory %' },
        ],
        filter: 'none',
      };
    case 'cost':
      return {
        name: templateName(template),
        kind: 'VirtualMachine',
        presentation: 'list',
        columns: [
          { key: 'cost|monthlyTotalCost', label: 'Monthly total cost' },
          { key: 'cost|monthlyProjectedCost', label: 'Projected cost this month' },
          { key: 'summary|parentCluster', label: 'Cluster', property: true },
        ],
        filter: 'none',
      };
    default:
      return {
        name: templateName('capacity'),
        kind: 'ClusterComputeResource',
        presentation: 'list',
        columns: [
          { key: 'OnlineCapacityAnalytics|capacityRemainingPercentage', label: 'Capacity remaining %' },
          { key: 'OnlineCapacityAnalytics|timeRemaining', label: 'Time remaining (days)' },
          { key: 'cpu|demandPct', label: 'CPU demand %' },
          { key: 'mem|host_usagePct', label: 'Memory usage %' },
          { key: 'summary|number_running_vms', label: 'Running VMs' },
        ],
        filter: 'none',
      };
  }
}

// ---------------------------------------------------------------------------
// Dashboards: the widget grid, its checks and its layout
// ---------------------------------------------------------------------------

/** The widget grid's columns, as the page's grid editor reads them from the hint. */
const GRID_HINT = 'Type | Title | Settings (key=value; …) | Position (x,y,w,h — or w,h or auto) | Provider (yes/no) | Receives from (a widget title)';

/** The grid's dropdowns: an option's group is the column it belongs to. */
const GRID_OPTIONS = [
  ...WIDGET_TYPES.map((type) => ({ value: type.type, label: `${type.label}${type.label === type.type ? '' : ` (${type.type})`}${type.deprecated ? ' — deprecated' : ''}${type.verified ? '' : ' — unverified'}`, group: 'Type' })),
  { value: 'yes', label: 'Yes', group: 'Provider' },
  { value: 'no', label: 'No', group: 'Provider' },
];

const GRID_COLUMNS = 12;

/** One row of the widget grid, as typed. */
                            
                         
                            
                                        
                         
                              
                            
                                
                            
 

                                                 
                            
                     
                     
                     
                     
 

/**
 * Cells of a " | " row. Metric keys hold a bare "|" themselves, so only a pipe
 * with a space either side separates cells (as the grid editor writes them).
 */
function cellsOf(line        )           {
  // Lookarounds, so "a | | b" (an empty cell) splits into three: the spaces are not used up.
  return ` ${line} `.split(/(?<=\s)\|(?=\s)/).map((cell) => cell.trim());
}

export function parseWidgetRows(text        )              {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line, index) => {
      const [typeName = '', title = '', settings = '', position = '', provider = '', receives = ''] = cellsOf(line);
      return { index, typeName, type: widgetType(typeName), title, settings: new Settings(settings), position: position || 'auto', providerText: provider, receives };
    });
}

function overlaps(a                                                , b                                                )          {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** x,y,w,h; w,h (placed automatically at that size); or auto (placed at the type's own size). */
function positionOf(row           , type            )                                                                                                            {
  const text = row.position.trim().toLowerCase();
  if (type.type === 'Section') {
    const parts = text === 'auto' ? [] : text.split(',').map((n) => Number(n.trim()));
    if (parts.length === 4 && Number.isInteger(parts[1]) && parts[1]  > 0) return { fixed: { x: 1, y: parts[1] , w: GRID_COLUMNS, h: 1 } };
    return { size: { w: GRID_COLUMNS, h: 1 } };
  }
  if (text === 'auto' || text === '') return { size: type.size };
  const parts = text.split(',').map((n) => Number(n.trim()));
  if (!parts.every((n) => Number.isInteger(n) && n > 0)) return { bad: `"${row.position}" is not x,y,w,h, w,h or auto with positive whole numbers` };
  if (parts.length === 4) return { fixed: { x: parts[0] , y: parts[1] , w: parts[2] , h: parts[3]  } };
  if (parts.length === 2) return { size: { w: parts[0] , h: parts[1]  } };
  return { bad: `"${row.position}" is not x,y,w,h, w,h or auto` };
}

/**
 * Lay the widgets out on the 12-column grid: the fixed ones where they say,
 * then each automatic one, in row order, in the first gap it fits — top row
 * first, left to right — which is how the dashboard editor fills a gap.
 */
export function layoutWidgets(rows                      )                                                                              {
  const placed                 = [];
  const problems                                        = [];
  const pending                                                                         = [];
  for (const row of rows) {
    if (!row.type) continue;
    const position = positionOf(row, row.type);
    if (position.bad) problems.push({ row, message: position.bad });
    else if (position.fixed) placed.push({ ...row, type: row.type, ...position.fixed });
    else if (position.size) {
      if (position.size.w > GRID_COLUMNS) problems.push({ row, message: `is ${position.size.w} wide, more than the ${GRID_COLUMNS} columns there are` });
      else pending.push({ row, type: row.type, size: position.size });
    }
  }
  for (const { row, type, size } of pending) {
    const bottom = placed.reduce((max, widget) => Math.max(max, widget.y + widget.h), 1);
    let spot                                      ;
    for (let y = 1; y <= bottom && !spot; y += 1) {
      for (let x = 1; x + size.w - 1 <= GRID_COLUMNS && !spot; x += 1) {
        const rect = { x, y, w: size.w, h: size.h };
        if (!placed.some((widget) => overlaps(widget, rect))) spot = { x, y };
      }
    }
    placed.push({ ...row, type, x: spot?.x ?? 1, y: spot?.y ?? bottom, w: size.w, h: size.h });
  }
  placed.sort((a, b) => a.index - b.index);
  return { placed, problems };
}

/** The sender each widget receives from, by row index, following "Receives from" titles. */
function senderIndex(rows                      )                      {
  const byTitle = new Map(rows.map((row) => [row.title.toLowerCase(), row.index]));
  const out = new Map                ();
  for (const row of rows) {
    if (!row.receives) continue;
    const sender = byTitle.get(row.receives.toLowerCase());
    if (sender !== undefined) out.set(row.index, sender);
  }
  return out;
}

/** Rows caught in a loop of "Receives from": each drives the next until it drives itself. */
export function interactionCycles(rows                      )             {
  const senders = senderIndex(rows);
  const cycles             = [];
  const reported = new Set        ();
  for (const row of rows) {
    const path           = [];
    let current                     = row.index;
    while (current !== undefined && !path.includes(current)) {
      path.push(current);
      current = senders.get(current);
    }
    if (current === undefined) continue;
    const loop = path.slice(path.indexOf(current));
    if (loop.some((index) => reported.has(index))) continue;
    for (const index of loop) reported.add(index);
    cycles.push(loop.map((index) => rows[index] .title));
  }
  return cycles;
}

const PROVIDER_YES = /^(yes|y|true|on|1)$/i;
const PROVIDER_NO = /^(no|n|false|off|0|)$/i;

/**
 * Every check on the widget grid, as findings: rows that do not parse, types
 * the catalogue does not have, settings a type needs and does not get, bad
 * metric keys, positions off the grid or on top of each other, and
 * interactions that name no widget, name one that cannot send, or go round in
 * a loop.
 */
export function checkWidgetRows(rows                      , placed                         , layoutProblems                                                )            {
  const findings            = [];
  const name = (row           )         => `"${row.title || `row ${row.index + 1}`}"`;
  if (rows.length === 0) findings.push(error('vcfops.dashboard.no-widgets', 'The widget grid is empty, so the dashboard would be a blank page.', { source: SRC }));

  const titles = new Map                ();
  for (const row of rows) {
    if (!row.title) findings.push(error('vcfops.dashboard.no-title', `Row ${row.index + 1} (${row.typeName || 'no type'}) has no title.`, { remediation: 'Every widget needs a title: it is what "Receives from" and navigations name.', source: SRC }));
    else titles.set(row.title.toLowerCase(), (titles.get(row.title.toLowerCase()) ?? 0) + 1);
  }
  const dupes = [...titles.entries()].filter(([, count]) => count > 1).map(([title]) => title);
  if (dupes.length > 0) findings.push(error('vcfops.dashboard.duplicate-title', `More than one widget is titled ${dupes.map((t) => `"${t}"`).join(', ')}.`, { remediation: '"Receives from" finds a widget by its title, so titles must be unique.', source: SRC }));

  for (const row of rows) {
    if (!row.type) {
      findings.push(
        error('vcfops.dashboard.unknown-type', `${name(row)}: "${row.typeName}" is not a VCF Operations widget type.`, {
          remediation: `Use one of: ${WIDGET_TYPES.map((t) => t.type).join(', ')} (or its name in the widget list, such as Top-N or Object List).`,
          source: SRC,
        }),
      );
      continue;
    }
    const provider = PROVIDER_YES.test(row.providerText);
    if (!provider && !PROVIDER_NO.test(row.providerText)) findings.push(error('vcfops.dashboard.bad-provider', `${name(row)}: Provider is "${row.providerText}", not yes or no.`, { source: SRC }));
    const { errors, warnings } = settingProblems(row.type, row.settings, provider);
    if (errors.length > 0) findings.push(error('vcfops.dashboard.bad-setting', `${name(row)} (${row.type.label}): ${errors.join('; ')}.`, { remediation: `A ${row.type.label} takes ${row.type.settings.map((s) => `${s.key}${s.required ? '*' : ''} (${s.help})`).join('; ') || 'no settings'}.`, source: SRC }));
    if (warnings.length > 0) findings.push(warning('vcfops.dashboard.setting-ignored', `${name(row)}: ${warnings.join('; ')}.`, { source: SRC }));
    if (!row.type.verified) {
      findings.push(
        warning('vcfops.dashboard.unverified-widget', `${name(row)}: no real export of a ${row.type.label} widget was found, so its config (${row.type.type}) is what the product documentation implies.`, {
          remediation: `${row.type.note ?? ''} Open the widget after import and save it once; export it to see the config your release writes. Source: ${row.type.source}.`.trim(),
          source: SRC,
        }),
      );
    }
    if (row.type.deprecated) findings.push(warning('vcfops.dashboard.deprecated-widget', `${name(row)}: ${row.type.label} is deprecated in VCF Operations 9 and will be removed.`, { source: SRC }));
    if (provider && row.receives) {
      findings.push(error('vcfops.dashboard.provider-receives', `${name(row)} provides for itself and also receives from "${row.receives}".`, { remediation: 'A self-providing widget ignores what it is sent. Set Provider to no, or clear Receives from.', source: SRC }));
    }
    if (!provider && !row.receives && row.type.needsSubject && !(row.type.type === 'AlertList' && row.settings.yes('world', false))) {
      findings.push(warning('vcfops.dashboard.no-subject', `${name(row)} neither provides for itself nor receives from another widget, so it opens empty.`, { remediation: 'Set Provider to yes, or name the widget whose selection drives it in Receives from.', source: SRC }));
    }
  }

  // Interactions.
  const byTitle = new Map(rows.map((row) => [row.title.toLowerCase(), row]));
  for (const row of rows) {
    if (!row.receives) continue;
    const sender = byTitle.get(row.receives.toLowerCase());
    if (!sender) findings.push(error('vcfops.dashboard.unknown-sender', `${name(row)} receives from "${row.receives}", which is not a widget on this dashboard.`, { remediation: 'Receives from takes the title of another widget in the grid, exactly as written there.', source: SRC }));
    else if (sender === row) findings.push(error('vcfops.dashboard.interaction-cycle', `${name(row)} receives from itself.`, { source: SRC }));
    else if (sender.type && !sender.type.provides) findings.push(error('vcfops.dashboard.sender-cannot-provide', `${name(row)} receives from "${sender.title}", a ${sender.type.label}, which cannot send a selection.`, { remediation: `Widgets that send: ${WIDGET_TYPES.filter((t) => t.provides).map((t) => t.label).join(', ')}.`, source: SRC }));
  }
  for (const loop of interactionCycles(rows).filter((cycle) => cycle.length > 1)) {
    findings.push(error('vcfops.dashboard.interaction-cycle', `The interactions go round in a loop: ${[...loop, loop[0]].map((t) => `"${t}"`).join(' → ')}.`, { remediation: 'Each widget should be driven from one direction; break the loop at the widget that should start it (Provider yes).', source: SRC }));
  }

  // Layout.
  for (const { row, message } of layoutProblems) findings.push(error('vcfops.dashboard.bad-position', `${name(row)}: ${message}.`, { source: SRC }));
  const offGrid = placed.filter((widget) => widget.x + widget.w - 1 > GRID_COLUMNS);
  if (offGrid.length > 0) {
    findings.push(error('vcfops.dashboard.off-grid', `${offGrid.map((w) => `"${w.title}"`).join(', ')} run${offGrid.length === 1 ? 's' : ''} past column ${GRID_COLUMNS}.`, { remediation: `x + w − 1 must be ${GRID_COLUMNS} or less on a ${GRID_COLUMNS}-column dashboard.`, source: SRC }));
  }
  const clashes           = [];
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      if (overlaps(placed[i] , placed[j] )) clashes.push(`"${placed[i] .title}" and "${placed[j] .title}"`);
    }
  }
  if (clashes.length > 0) {
    findings.push(
      error('vcfops.dashboard.overlap', `Widgets overlap on the grid: ${clashes.join('; ')}.`, {
        remediation: 'Gridster pushes overlapping widgets down on import, so the dashboard you open is not the one you wrote. Move them so no two rectangles share a cell, or set one to auto.',
        source: SRC,
      }),
    );
  }
  return findings;
}

/** "Widget title -> Dashboard name", one per line. */
function parseNavigations(text        )                                               {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [from = '', to = ''] = line.split(/\s*(?:->|→)\s*/);
      return { from: from.trim(), to: to.trim(), line };
    });
}

/** The dashboard time state the exports carry (permDashboardTime_dashboard_<id>), for the ranges seen in them. */
const TIME_RANGES                                   = {
  last6Hour: 'o%3AdateRange%3Ds%253Alast6Hour%5EdateRangeText%3Ds%253A6H',
  last24Hour: 'o%3AdateRange%3Ds%253Alast24Hour%5EdateRangeText%3Ds%253A24H',
  last7Days: 'o%3AdateRange%3Ds%253Alast7Days%5EdateRangeText%3Ds%253A7D',
};

/** A property whose value is text rather than a number, for isStringAttribute. */
function isStringProperty(column            )          {
  return column.property === true && !/num_|memoryKB|corecount|number_|Count$|capacity|DAYS_TO|_days$/i.test(column.key);
}

/** The options a view gets when nothing else is said: what the templates and the old blueprint wrote. */
function defaultViewOptions(view              )              {
  return {
    description: ` Filter: ${view.filter}.`,
    subjects: [kindRef(view.kind)],
    relation: 'both',
    usages: ['dashboard', 'report', 'details'],
    time: { mode: 'relative', unit: view.presentation === 'list' || view.presentation === 'summary' ? 'HOURS' : 'DAYS', count: view.presentation === 'list' || view.presentation === 'summary' ? 24 : 30 },
    pageSize: 50,
    topN: -1,
    chart: 'bar-chart',
    buckets: { mode: 'discrete', ranges: [], count: 10, min: 0, max: 100 },
    trend: { historical: true, line: true, forecastDays: 0 },
    filter: [],
    text: '',
  };
}

const P = (name        , value                           )         => `<Property name="${name}" value="${xml(String(value))}"/>`;

/**
 * One column as an attributes-selector item, in the order a real export writes
 * the properties: objectType, attributeKey, preferredUnitId, isStringAttribute,
 * the kind binding, rollUpType, rollUpCount, percentile / forecastDays, the
 * transformations list, sortCriteria, isProperty, displayName, then the related
 * object when the column reads one (brockpeterson and sentania-labs exports).
 */
function viewItem(view              , opts             , column            )           {
  const pad = '                                        ';
  if (column.timeSegment) {
    // The "Interval Breakdown" pseudo-column: exactly the nine properties of the
    // export it was read from (sentania-labs, "VCF Licensing Overtime").
    return [
      '                                <Item>',
      '                                    <Value>',
      ...[P('objectType', 'RESOURCE'), P('attributeKey', 'Interval Breakdown'), P('rollUpCount', 0), P('sortCriteria', false), P('isTimeSegment', true), P('breakdownBy', column.timeSegment), P('startingOnUnit', 'WEEKS'), P('startingOnCount', 1), P('displayName', column.label)].map((line) => `${pad}${line}`),
      '                                    </Value>',
      '                                </Item>',
    ];
  }
  const multi = opts.subjects.length > 1;
  // A column bound to one kind reads only rows of that kind; on a view with
  // several kinds an unbound column resolves against each (sentania-labs,
  // view_multi_subject_column_binding). A related column carries the related
  // object's kind, and the row's kind as relatedResourceKind.
  const binding                      = column.related ? column.related.kind : column.kind ?? (multi ? undefined : opts.subjects[0]);
  const distributionProperty = view.presentation === 'distribution' && column.property;
  const transforms           =
    view.presentation === 'trend'
      ? [...(opts.trend.historical ? ['NONE'] : []), ...(opts.trend.line ? ['TREND'] : []), ...(opts.trend.forecastDays > 0 ? ['FORECAST'] : [])]
      : [column.transform ?? 'CURRENT'];
  const lines = [
    P('objectType', 'RESOURCE'),
    P('attributeKey', column.key),
    ...(column.unit ? [P('preferredUnitId', column.unit)] : []),
    P('isStringAttribute', isStringProperty(column)),
    ...(binding ? [P('adapterKind', binding.adapterKind), P('resourceKind', binding.resourceKind)] : []),
    ...(column.property ? [] : [P('rollUpType', 'NONE')]),
    P('rollUpCount', 0),
    ...(column.transform === 'PERCENTILE' ? [P('percentile', column.percentile ?? 95)] : []),
    ...((view.presentation === 'trend' && opts.trend.forecastDays > 0) || column.transform === 'FORECAST' ? [P('forecastDays', opts.trend.forecastDays > 0 ? opts.trend.forecastDays : 30)] : []),
    // A property on a distribution is bucketed as it stands: the working
    // export carries no transformations for it (sentania-labs, DEF-012).
    ...(distributionProperty ? [] : ['<Property name="transformations">', '    <List>', ...(transforms.length > 0 ? transforms : ['NONE']).map((t) => `        <Item value="${t}"/>`), '    </List>', '</Property>']),
    ...(column.sort ? [P('sortCriteria', true)] : []),
    P('isProperty', column.property === true),
    P('displayName', column.label),
    ...(column.related && opts.subjects[0] ? [P('relatedAdapterKind', opts.subjects[0].adapterKind), P('relatedResourceKind', opts.subjects[0].resourceKind), P('relatedRelationType', column.related.relation)] : []),
  ];
  return ['                                <Item>', '                                    <Value>', ...lines.map((line) => `${pad}${line}`), '                                    </Value>', '                                </Item>'];
}

/** The SubjectType filter= JSON: OR of AND groups; here one AND group. */
function subjectFilterJson(conditions                             )         {
  if (conditions.length === 0) return '';
  return JSON.stringify([
    conditions.map((c) => ({
      condition: c.condition,
      transform: 'CURRENT',
      metricKey: c.key,
      metricValue: { isStringMetric: typeof c.value === 'string', value: c.value },
      filterType: c.filterType,
    })),
  ]);
}

/**
 * The view as content.xml — the shape of a Views → Export: ViewDef with Title,
 * Description, SubjectType, Usage, and Controls holding a time-interval selector
 * and an attributes selector whose items are the columns, then DataProviders and
 * Presentation. Every element and property here is one a real export carries
 * (notoriousbdg, brockpeterson/operations_dashboards, sentania-labs; see
 * vcfops-import.ts); where the form is not in any export seen, the blueprint
 * says VERIFY.
 *
 *   list / summary   list-view provider, Presentation list or summary, pagination
 *   trend            trend-view provider, Presentation line-chart
 *   distribution     distribution-view provider, a buckets-control, Presentation
 *                    bar-chart, pie-chart or donut-chart
 *   text             no subject and no provider: Presentation text holding HTML
 *   image            no subject: Presentation image holding the picture as base64
 */
function viewXml(view              , opts             )         {
  const id = viewIdOf(view.name);
  const i = (n        , line        )         => `${' '.repeat(n)}${line}`;
  const filter = subjectFilterJson(opts.filter);
  const filterAttr = filter ? ` filter="${xml(filter)}"` : '';
  const usages = [...opts.usages.filter((u) => ['dashboard', 'report', 'details'].includes(u) && !((view.presentation === 'text' || view.presentation === 'image') && u === 'details')), 'content'];
  const subjects = view.presentation === 'text' || view.presentation === 'image' ? [] : opts.subjects.flatMap((kind) => [
    ...(opts.relation === 'self' ? [] : [i(12, `<SubjectType adapterKind="${xml(kind.adapterKind)}"${filterAttr} resourceKind="${xml(kind.resourceKind)}" type="descendant"/>`)]),
    ...(opts.relation === 'descendant' ? [] : [i(12, `<SubjectType adapterKind="${xml(kind.adapterKind)}"${filterAttr} resourceKind="${xml(kind.resourceKind)}" type="self"/>`)]),
  ]);
  const time = [
    i(16, '<Control id="time-interval-selector_id_1" type="time-interval-selector" visible="false">'),
    i(20, P('advancedTimeMode', opts.time.mode !== 'relative')),
    i(20, P('unit', opts.time.unit)),
    i(20, P('count', opts.time.count)),
    // PREVIOUS / NOW is the one advanced range seen in an export (sentania-labs,
    // FB-011); startDate / endDate for a fixed range is not (VERIFY, in the notes).
    ...(opts.time.mode === 'advanced' ? [i(20, P('startPeriod', 'PREVIOUS')), i(20, P('endPeriod', 'NOW'))] : []),
    ...(opts.time.mode === 'absolute' ? [i(20, P('startDate', opts.time.from ?? 0)), i(20, P('endDate', opts.time.to ?? 0))] : []),
    i(16, '</Control>'),
  ];
  const head = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Content>',
    '    <Views>',
    i(8, `<ViewDef id="${id}">`),
    i(12, `<Title>${xml(view.name)}</Title>`),
    i(12, `<Description>${xml(opts.description)}</Description>`),
    ...subjects,
    ...usages.map((u) => i(12, `<Usage>${u}</Usage>`)),
  ];
  const tail = ['        </ViewDef>', '    </Views>', '</Content>', ''];

  if (view.presentation === 'text') {
    return [...head, i(12, '<Controls>'), ...time, i(12, '</Controls>'), i(12, '<Presentation type="text">'), i(16, '<Properties>'), i(20, P('text', opts.text)), i(16, '</Properties>'), i(12, '</Presentation>'), ...tail].join('\n');
  }
  if (view.presentation === 'image') {
    return [...head, i(12, '<Presentation type="image">'), i(16, '<DataBinding>'), i(20, `<Source>${xml(IMAGE_PLACEHOLDER)}</Source>`), i(16, '</DataBinding>'), i(12, '</Presentation>'), ...tail].join('\n');
  }

  const numeric = view.columns.map((column, index) => ({ column, index })).filter(({ column }) => !column.property && !column.timeSegment).map(({ index }) => index);
  const summary =
    (view.presentation === 'list' || view.presentation === 'summary') && opts.summary
      ? [
          i(20, '<Property name="summaryInfos">'),
          i(24, '<List>'),
          i(28, '<Item>'),
          i(32, '<Value>'),
          i(36, P('displayName', opts.summary === 'SUM' ? 'Total' : opts.summary === 'AVG' ? 'Average' : opts.summary === 'MIN' ? 'Lowest' : opts.summary === 'MAX' ? 'Highest' : 'Count')),
          i(36, P('aggregation', opts.summary)),
          i(36, '<Property name="attributeIndexes">'),
          i(40, '<List>'),
          ...numeric.map((index) => i(44, `<Item value="${index}"/>`)),
          i(40, '</List>'),
          i(36, '</Property>'),
          i(32, '</Value>'),
          i(28, '</Item>'),
          i(24, '</List>'),
          i(20, '</Property>'),
        ]
      : [];
  const attributes = [
    i(16, '<Control id="attributes-selector_id_1" type="attributes-selector" visible="false">'),
    i(20, '<Property name="attributeInfos">'),
    i(24, '<List>'),
    ...view.columns.flatMap((column) => viewItem(view, opts, column)),
    i(24, '</List>'),
    i(20, '</Property>'),
    ...summary,
    i(16, '</Control>'),
  ];
  const b = opts.buckets;
  const buckets =
    view.presentation !== 'distribution'
      ? []
      : b.mode === 'discrete'
        ? [i(16, '<Control id="buckets-control_id_1" type="buckets-control" visible="false">'), i(20, P('dynamicCalcFunction', 'DISCRETE')), i(20, P('isDynamic', true)), i(20, P('isSum', false)), i(16, '</Control>')]
        : b.mode === 'ranges'
          ? [
              i(16, '<Control id="buckets-control_id_1" type="buckets-control" visible="false">'),
              i(20, P('maxValue', 0)),
              i(20, P('minValue', 0)),
              i(20, P('dynamicCalcFunction', 'SIMPLEMAXMIN')),
              i(20, '<Property name="bucketInfos">'),
              i(24, '<List>'),
              ...b.ranges.flatMap((range) => [i(28, '<Item>'), i(32, '<Value>'), i(36, P('startValue', range.start)), i(36, P('endValue', range.end)), i(36, P('bucketColor', range.color)), i(32, '</Value>'), i(28, '</Item>')]),
              i(24, '</List>'),
              i(20, '</Property>'),
              i(20, P('isDynamic', false)),
              i(20, P('isSum', false)),
              i(16, '</Control>'),
            ]
          : [i(16, '<Control id="buckets-control_id_1" type="buckets-control" visible="false">'), i(20, P('isDynamic', false)), i(20, P('minValue', b.min)), i(20, P('maxValue', b.max)), i(20, P('bucketCount', b.count)), i(20, P('isSum', false)), i(16, '</Control>')];
  const pagination =
    view.presentation === 'distribution'
      ? []
      : [i(16, '<Control id="pagination-control_id_1" type="pagination-control" visible="true">'), i(20, P('start', 0)), i(20, P('size', opts.pageSize)), i(16, '</Control>')];
  const metadata = [
    i(16, '<Control id="metadata_id_1" type="metadata" visible="false">'),
    i(20, P('maxPointsCount', 5000)),
    i(20, P('hideObjectNameColumn', false)),
    i(20, P('listTopResultSize', opts.topN > 0 ? opts.topN : -1)),
    i(16, '</Control>'),
  ];
  const dataType = view.presentation === 'trend' ? 'trend-view' : view.presentation === 'distribution' ? 'distribution-view' : 'list-view';
  const presentation = view.presentation === 'trend' ? 'line-chart' : view.presentation === 'distribution' ? opts.chart : view.presentation;
  return [
    ...head,
    i(12, '<Controls>'),
    ...time,
    ...attributes,
    ...buckets,
    ...pagination,
    ...metadata,
    i(12, '</Controls>'),
    i(12, '<DataProviders>'),
    i(16, `<DataProvider dataType="${dataType}" id="${dataType}_id_1"/>`),
    i(12, '</DataProviders>'),
    i(12, `<Presentation type="${presentation}"/>`),
    ...tail,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// VCF Operations: build
// ---------------------------------------------------------------------------

export const VCF_OPS_BUILD                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_dashboard',
    platform: PLATFORM,
    label: 'A dashboard, as importable JSON',
    group: 'Dashboards and reports',
    description:
      'A dashboard built widget by widget — any of the widgets VCF Operations 9 offers, each with its own settings, placed on the 12-column grid or flowed into it, and wired so one widget’s selection drives another — starting from one of the standard dashboards. It is written as the JSON a dashboard export holds, checked for missing settings, bad metric keys, overlaps and interaction loops before anything is built, and reads back on the VCF Ops content page like any exported dashboard.',
    inputs: [
      { id: 'template', label: 'Start from', control: 'select', options: DASHBOARD_TEMPLATES.map((t) => ({ value: t.value, label: t.label })), default: 'capacity', hint: 'Fills the widget grid below; change any row after' },
      ...DASHBOARD_TEMPLATES.map((t) => ({
        id: `widgets_${t.value}`,
        label: 'Widgets',
        control: 'textarea'         ,
        default: t.rows.map((row) => row.join(' | ')).join('\n'),
        hint: GRID_HINT,
        help: catalogueHelp(),
        options: GRID_OPTIONS,
        showWhen: { input: 'template', equals: [t.value] },
      })),
      { id: 'dashboard_name', label: 'Dashboard name', control: 'text', default: '', placeholder: 'Defaults to the template name' },
      { id: 'folder', label: 'Folder', control: 'text', default: '', placeholder: 'None', hint: 'Where it sits in the dashboard list' },
      { id: 'description', label: 'Description', control: 'text', default: '', placeholder: 'Defaults to what the template shows' },
      {
        id: 'sharing',
        label: 'Shared with',
        control: 'select',
        options: [
          { value: 'everyone', label: 'Everyone' },
          { value: 'groups', label: 'Named user groups' },
          { value: 'private', label: 'Only the importing user' },
        ],
        default: 'everyone',
      },
      { id: 'share_groups', label: 'User groups', control: 'text', default: 'VCF Operations Admins', hint: 'Comma separated; Group@SOURCE for a group from an identity source', showWhen: { input: 'sharing', equals: ['groups'] } },
      {
        id: 'refresh',
        label: 'Widgets refresh every',
        control: 'select',
        options: [
          { value: '60', label: '1 minute' },
          { value: '120', label: '2 minutes' },
          { value: '300', label: '5 minutes' },
          { value: '600', label: '10 minutes' },
          { value: '900', label: '15 minutes' },
          { value: '1800', label: '30 minutes' },
          { value: '3600', label: '1 hour' },
        ],
        default: '300',
        hint: 'refresh= on a row overrides it',
      },
      { id: 'refresh_content', label: 'Widgets refresh their data', control: 'toggle', default: true },
      {
        id: 'time_range',
        label: 'Dashboard time range',
        control: 'select',
        options: [
          { value: 'none', label: 'Each widget’s own' },
          { value: 'last6Hour', label: 'Last 6 hours' },
          { value: 'last24Hour', label: 'Last 24 hours' },
          { value: 'last7Days', label: 'Last 7 days' },
        ],
        default: 'none',
      },
      { id: 'home_tab', label: 'Open it as the home tab', control: 'toggle', default: false },
      { id: 'locked', label: 'Lock it against editing', control: 'toggle', default: false },
      { id: 'autoswitch', label: 'Switch to the next dashboard automatically', control: 'toggle', default: false },
      { id: 'autoswitch_delay', label: 'Switch after (seconds)', control: 'number', default: 300, min: 5, max: 3600, showWhen: { input: 'autoswitch', equals: ['true'] } },
      { id: 'navigations', label: 'Open another dashboard from a widget', control: 'textarea', default: '', placeholder: 'Clusters -> ESX host health', hint: 'One per line: widget title -> dashboard name' },
      { id: 'max_widgets', label: 'Warn above (widgets)', control: 'number', default: 10, min: 1, max: 40, hint: 'Every widget is a query on every refresh' },
    ],
    automation: (values                 , name        )             => {
      const template = templateOf(str(values, 'template', 'capacity'));
      const baseName = str(values, 'dashboard_name', template.label);
      const folder = str(values, 'folder', '').replace(/^\/+|\/+$/g, '');
      // The folder is the leading segment of the name, and namePath mirrors it:
      // namePath alone does not put a dashboard in a folder (CF render.py,
      // matching the vROpsTOP and tkopton bundles).
      const dashName = folder ? `${folder}/${baseName}` : baseName;
      const description = str(values, 'description', template.about);
      const sharing = str(values, 'sharing', 'everyone');
      const shareGroups = listOf(str(values, 'share_groups', ''));
      const shared = sharing !== 'private';
      const refresh = num(values, 'refresh', 300);
      const refreshContent = bool(values, 'refresh_content', true);
      const timeRange = str(values, 'time_range', 'none');
      const homeTab = bool(values, 'home_tab', false);
      const locked = bool(values, 'locked', false);
      const autoswitch = bool(values, 'autoswitch', false);
      const autoswitchDelay = num(values, 'autoswitch_delay', 300);
      const maxWidgets = num(values, 'max_widgets', 10);
      const rowsText = str(values, `widgets_${template.value}`, template.rows.map((row) => row.join(' | ')).join('\n'));

      const rows = parseWidgetRows(rowsText);
      const { placed, problems } = layoutWidgets(rows);
      const findings            = checkWidgetRows(rows, placed, problems);
      if (placed.length > maxWidgets) {
        findings.push(
          warning('vcfops.dashboard.too-many', `${placed.length} widgets, more than the ${maxWidgets} you set as a limit.`, {
            remediation: 'Each widget queries on every refresh, for every viewer. Split it into two dashboards and open one from the other (a navigation).',
            source: SRC,
          }),
        );
      }
      if (sharing === 'groups' && shareGroups.length === 0) findings.push(error('vcfops.dashboard.no-groups', 'Shared with named user groups, but no group is named.', { source: SRC }));
      const groups = shareGroups.map((group) => {
        const at = group.lastIndexOf('@');
        return at > 0 ? { name: group.slice(0, at).trim(), source: group.slice(at + 1).trim().toUpperCase() } : { name: group, source: 'LOCAL' };
      });
      if (sharing === 'groups' && groups.some((group) => group.source !== 'LOCAL')) {
        findings.push(
          warning('vcfops.dashboard.group-source', `${groups.filter((g) => g.source !== 'LOCAL').map((g) => `${g.name}@${g.source}`).join(', ')}: only sourceType LOCAL has been seen in a dashboardsharings file.`, {
            remediation: 'Share one dashboard with that group in the interface, export it (export-reference.sh) and compare its dashboardsharings entry before importing.',
            source: SRC,
          }),
        );
      }

      const dashId = stableId(`dashboard:${baseName}`);
      const ids = new Map(placed.map((widget) => [widget.index, stableId(`widget:${baseName}:${widget.index}:${widget.title}`)]));
      const byTitle = new Map(placed.map((widget) => [widget.title.toLowerCase(), widget]));
      const entries = new Entries();
      const viewNames = new Set        ();
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      // Sections hold the widgets below them, down to the next section.
      const sections = placed.filter((widget) => widget.type.type === 'Section').sort((a, b) => a.y - b.y);
      const sectionMembers = (section              )           => {
        const next = sections.find((other) => other.y > section.y);
        return placed.filter((widget) => widget.type.type !== 'Section' && widget.y > section.y && (!next || widget.y < next.y)).map((widget) => ids.get(widget.index) );
      };

      const widgetsJson = placed.map((widget) => {
        const selfProvider = PROVIDER_YES.test(widget.providerText) && !widget.receives;
        const rowRefresh = widget.settings.get('refresh');
        const ctx                = {
          id: ids.get(widget.index) ,
          title: widget.title,
          selfProvider,
          refreshInterval: /^\d+$/.test(rowRefresh) ? Number(rowRefresh) : refresh,
          refreshContent: /^off$/i.test(rowRefresh) ? false : refreshContent,
          s: widget.settings,
          entries,
          viewId: (view) => {
            if (uuid.test(view)) return view;
            viewNames.add(view);
            return viewIdOf(view);
          },
        };
        const config = widget.type.build(ctx);
        if (widget.type.type === 'Section') config['widgets'] = sectionMembers(widget);
        return {
          id: ctx.id,
          type: widget.type.type,
          title: widget.title,
          collapsed: widget.type.type === 'Section' ? widget.settings.yes('collapsed', false) : false,
          gridsterCoords: { x: widget.x, y: widget.y, w: widget.w, h: widget.h },
          config,
        };
      });

      // "Receives from" becomes a widget interaction: resourceId, or metricId from a Metric Picker (BP exports).
      const interactions = placed
        .filter((widget) => widget.receives && byTitle.get(widget.receives.toLowerCase()) && byTitle.get(widget.receives.toLowerCase()) !== widget)
        .map((widget) => {
          const sender = byTitle.get(widget.receives.toLowerCase()) ;
          return { type: sender.type.type === 'MetricPicker' ? 'metricId' : 'resourceId', widgetIdProvider: ids.get(sender.index) , widgetIdReceiver: ids.get(widget.index)  };
        });

      // Navigations: {<sending widget id>: [{id: <dashboard id>, widgets: []}]}, as the
      // notoriousbdg showback and content-factory exports carry them. The target's id is
      // the one this blueprint derives from its name.
      const navigations                                                       = {};
      const navTargets           = [];
      for (const nav of parseNavigations(str(values, 'navigations', ''))) {
        const from = byTitle.get(nav.from.toLowerCase());
        if (!nav.from || !nav.to) {
          findings.push(error('vcfops.dashboard.bad-navigation', `"${nav.line}" is not widget title -> dashboard name.`, { source: SRC }));
        } else if (!from) {
          findings.push(error('vcfops.dashboard.bad-navigation', `The navigation "${nav.line}" starts from "${nav.from}", which is not a widget on this dashboard.`, { source: SRC }));
        } else if (!from.type.provides) {
          findings.push(error('vcfops.dashboard.bad-navigation', `The navigation "${nav.line}" starts from a ${from.type.label}, which cannot send a selection.`, { source: SRC }));
        } else if (nav.to.toLowerCase() === baseName.toLowerCase()) {
          findings.push(error('vcfops.dashboard.bad-navigation', `The navigation "${nav.line}" opens this dashboard itself.`, { source: SRC }));
        } else {
          const list = (navigations[ids.get(from.index) ] ??= []);
          list.push({ id: stableId(`dashboard:${nav.to}`), widgets: [] });
          navTargets.push(nav.to);
        }
      }
      if (navTargets.length > 0) {
        findings.push(
          info('vcfops.dashboard.navigation-target', `Navigations open ${[...new Set(navTargets)].map((t) => `"${t}"`).join(', ')} by the id this blueprint gives a dashboard of that name.`, {
            remediation: 'Generate and import those dashboards here too. A dashboard built by hand has another id: re-point the navigation in the dashboard editor.',
            source: SRC,
          }),
        );
      }
      for (const view of viewNames) {
        const fromTemplate = TEMPLATES.find((t) => t.label === view);
        findings.push(
          info('vcfops.dashboard.needs-view', `The View widget shows the view "${view}", id ${viewIdOf(view)}.`, {
            remediation: fromTemplate
              ? `Generate "A view for dashboards and reports" starting from "${fromTemplate.label}" and import it before the dashboard.`
              : `Generate "A view for dashboards and reports" with "My own columns" and the view name "${view}", and import it before the dashboard — or give the view’s UUID in view=.`,
            source: SRC,
          }),
        );
      }

      const dashboard = {
        entries: entries.toJson(),
        dashboards: [
          {
            id: dashId,
            name: dashName,
            namePath: folder,
            description,
            shared,
            temporary: false,
            hidden: false,
            homeTab,
            disabled: false,
            locked,
            autoswitchEnabled: autoswitch,
            ...(autoswitch ? { autoswitchDelay } : {}),
            columnCount: 1,
            columnProportion: '1',
            gridsterMaxColumns: 12,
            rank: 0,
            creationTime: 0,
            lastUpdateTime: 0,
            importAttempts: 0,
            importComplete: true,
            userId: DASHBOARD_OWNER_PLACEHOLDER,
            lastUpdateUserId: DASHBOARD_OWNER_PLACEHOLDER,
            states: TIME_RANGES[timeRange] ? [{ key: `permDashboardTime_dashboard_${dashId}`, value: TIME_RANGES[timeRange] }] : [],
            dashboardNavigations: navigations,
            widgetInteractions: interactions,
            widgets: widgetsJson,
          },
        ],
        uuid: stableId(`dashboard-export:${baseName}`),
      };
      const dashboardJson = `${JSON.stringify(dashboard, null, 2)}\n`;

      // Sharing: the content import files dashboardsharings/<owner> as a list of
      // {groupName, sourceType, dashboards} (content-factory packager and a real
      // export; "Everyone"/LOCAL is the only group seen).
      const everyone = '[{groupName: "Everyone", sourceType: "LOCAL", dashboards: [.dashboards[] | {dashboardId: .id}]}]';
      let script = contentImportScript({ what: `the dashboard "${dashName}"`, contentType: 'DASHBOARDS', needles: [`"name": ${JSON.stringify(dashName)}`, `"name":${JSON.stringify(dashName)}`, dashId], dashboard: { shared } });
      if (sharing === 'groups' && groups.length > 0) {
        const list = `[${groups.map((g) => `{groupName: ${JSON.stringify(g.name)}, sourceType: ${JSON.stringify(g.source)}, dashboards: [.dashboards[] | {dashboardId: .id}]}`).join(', ')}]`;
        script = script.replace(everyone, sq(list));
      }

      const viewList = [...viewNames];
      const orderedTypes = [...new Set(placed.map((widget) => widget.type.label))];
      return {
        platform: PLATFORM,
        title: `Dashboard "${dashName}" — ${placed.length} widgets`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Imported once by a person; it changes when someone edits it in the interface and re-exports it.', worstCase: 'once per import' },
        scope: {
          what: `One dashboard, "${dashName}" (${orderedTypes.join(', ') || 'no widgets'}), ${sharing === 'everyone' ? 'shared with every user' : sharing === 'groups' ? `shared with ${groups.map((g) => g.name).join(', ')}` : 'visible to the importing user'}.`,
          decidedBy: [
            'The dashboard id, derived from its name: importing it again replaces this dashboard and nothing else.',
            ...placed.filter((w) => w.settings.has('group')).map((w) => `The custom group "${w.settings.get('group')}" decides which objects "${w.title}" lists.`),
            ...(viewList.length > 0 ? viewList.map((view) => `The view "${view}" (id ${viewIdOf(view)}) must exist, from "A view for dashboards and reports".`) : ['No generated view.']),
          ],
          ifWrong: 'With --overwrite, a dashboard with the same name or id that somebody edited by hand is replaced by this one; their version is in the pre-import-backup zip the script took first. Without --overwrite the script refuses.',
        },
        guardrails: [
          { rule: 'Every widget row is checked before anything is built: its type, the settings that type needs, metric keys, its place on the grid, and what it receives from', because: 'A widget with a missing setting or a misspelt metric imports cleanly and opens empty, which reads as "no problems".' },
          { rule: 'Overlapping or off-grid widgets, and interactions that name no widget or go round in a loop, are errors', because: 'Gridster rearranges an overlapping layout on import, and a loop of interactions leaves every widget in it waiting for another.' },
          { rule: 'import-dashboard.sh stops while any payload holds <REQUIRED>', because: 'A dashboard imported with a placeholder view id shows an empty widget, which reads as "no problems".' },
          { rule: 'When it imports, the script first exports the existing DASHBOARDS content to pre-import-backup-<time>.zip and refuses to import when a dashboard with the same name or id is already there, unless --overwrite is given', because: 'The import API overwrites by default (force defaults to true), and somebody’s hand-edited copy would be gone with no copy kept.' },
          { rule: 'The import is sent with force=false unless --overwrite', because: 'Without it the API replaces whatever matches, which is the documented default.' },
          { rule: 'The script follows the import by the id its POST returned and exits 1 unless it reaches FINISHED with nothing failed or skipped, or when it times out', because: 'Reading the "last import" status can show an earlier import, and a FAILED import that exits 0 is taken as done.' },
          { rule: '--dry-run (opt-in) builds and lists the zip and sends nothing', because: 'The content-zip layout comes from real exports rather than a published specification; a --dry-run is for comparing it with an export-reference.sh export.' },
        ],
        dryRun: [
          'import-dashboard.sh imports when run. To look first, run it with --dry-run: it builds the content zip and lists it.',
          'Drop import/dashboard.zip on the VCF Ops content page first — it reads it as an export and shows the layout and any findings.',
          'Or import it by hand: Dashboards > Manage > Import, which takes import/dashboard.zip.',
        ],
        undo: ['Delete the dashboard under Dashboards > Manage. If --overwrite replaced one, put the previous version back by importing the pre-import-backup-<time>.zip the script wrote (POST /suite-api/api/content/operations/import) — the import API itself has no undo.'],
        told: [sharing === 'private' ? 'Nobody. The dashboard appears in the importing user’s list.' : 'Nobody. The dashboard appears in the list for the users it is shared with.'],
        requires: [
          ...viewList.map((view) => `The view "${view}", generated by "A view for dashboards and reports", imported first.`),
          ...(navTargets.length > 0 ? [`The dashboards it opens (${[...new Set(navTargets)].join(', ')}), generated here too.`] : []),
          'zip, unzip, jq and curl on the machine running the script.',
          'An account allowed to import content (Content admin or Administrator).',
        ],
        files: {
          'import/dashboard.zip/dashboard/dashboard.json': dashboardJson,
          'import/dashboard.zip/dashboard/resources/resources.properties': '',
          'import/dashboard.json': dashboardJson,
          ...contentPackage({}, {}),
          'import-dashboard.sh': script,
          'export-reference.sh': exportReferenceScript('DASHBOARDS'),
          'IMPORT.md': importMd({
            title: `the dashboard "${dashName}"`,
            steps: [
              ...viewList.map((view) => ({
                heading: `First, the view "${view}"`,
                files: [],
                how: [
                  TEMPLATES.some((t) => t.label === view)
                    ? `Generate "A view for dashboards and reports" starting from "${view}" and import its import/view.zip first.`
                    : `Generate "A view for dashboards and reports" with "My own columns", named "${view}", and import its import/view.zip first.`,
                  `The View widget refers to view id ${viewIdOf(view)}; without it the widget opens empty.`,
                ],
              })),
              {
                heading: 'The dashboard',
                files: ['import/dashboard.zip'],
                how: ['Dashboards → Manage → ⋯ → Import (8.x: Dashboards → Actions → Manage Dashboards → Import Dashboards), and choose import/dashboard.zip — a zip holding dashboard/dashboard.json, as a dashboard export is.', `The dashboard is created as the user who imports it, then ${sharing === 'private' ? 'kept private to them' : 'shared as set'}.`],
                verify: [
                  'import/dashboard.json is the same dashboard as a bare file. Import dialogs have taken the .json on its own in 8.x; if yours asks for a zip, use import/dashboard.zip.',
                  ...(placed.some((w) => !w.type.verified) ? [`widgets of a type no export was found for (${[...new Set(placed.filter((w) => !w.type.verified).map((w) => w.type.label))].join(', ')}): open each after import and save it once.`] : []),
                ],
              },
              contentStep('DASHBOARDS', 'import-dashboard.sh'),
            ],
            intro: IMPORT_INTRO,
            sources: [...CONTENT_SOURCES, 'Widget configs: real dashboard exports — github.com/sentania-labs/vcf-content-factory (a VCF Operations 9 renderer and a live-export survey), github.com/brockpeterson/operations_dashboards and github.com/notoriousbdg (VMware’s own 8.x dashboards).'],
          }),
        },
        notes: [
          CONTENT_IMPORT_NOTE,
          'The {entries, dashboards[], uuid} shape, widgets[] with gridsterCoords, widgetInteractions and dashboardNavigations are as real exports have them, and the VCF Ops content page parses the same file. entries lists the object types and objects the widgets refer to by resourceKind:id:N and resource:id:N; the importer resolves them by key and name on the target.',
          'Each widget’s config is the shape a real export of that type carries (the catalogue in vcf-ops-widgets.ts says which export). A type no export was found for is marked unverified and raises a warning.',
          'gridsterCoords are 1-based: x runs 1 to 12, y from 1 downwards. Rows marked auto (or w,h) are placed in the first gap they fit, top row first.',
          'A widget with Provider yes picks its own objects (selfProvider), pinned to the world object of its adapter where it needs one; a widget with Receives from follows that widget’s selection.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_view',
    platform: PLATFORM,
    label: 'A view for dashboards and reports',
    group: 'Dashboards and reports',
    description:
      'Any view VCF Operations 9.1 builds — list, summary, trend, distribution (bar, pie or donut), text or image — over one or several object types, run on the object itself or on its children and descendants. Each column is a metric or property with its own transformation (current, average, max, min, sum, percentile, forecast, first, last) and unit, or a value read from a related object; with the time range, sort, top-N, a summary row, a breakdown by period, property or relationship, a subject filter, trend and forecast settings, bucketed distributions and where the view may be shown. Written as content XML and imported, so a dashboard’s View widget and a report can use it; the id is derived from the name, so the dashboard template of the same name already points at it.',
    inputs: [
      { id: 'template', label: 'Start from', control: 'select', options: [...TEMPLATES.map((t) => ({ value: t.value, label: t.label })), { value: 'custom', label: 'My own columns' }], default: 'capacity' },
      { id: 'view_name', label: 'View name', control: 'text', default: 'VM right-sizing', showWhen: { input: 'template', equals: ['custom'] } },
      { id: 'kind', label: 'Object type', control: 'combo', options: KIND_OPTIONS, default: 'VirtualMachine', hint: 'Or Adapter/Kind for one not listed', showWhen: { input: 'template', equals: ['custom'] } },
      { id: 'more_kinds', label: 'More object types', control: 'text', default: '', placeholder: 'None', hint: 'Comma separated, for a view over several types; a column reads every type unless its Kind cell names one', showWhen: { input: 'template', equals: ['custom'] } },
      {
        id: 'subject_relation',
        label: 'Runs on',
        control: 'select',
        options: [
          { value: 'both', label: 'The object itself, and the children and descendants of what it is run on' },
          { value: 'descendant', label: 'Only the children and descendants of what it is run on' },
          { value: 'self', label: 'Only the object itself' },
        ],
        default: 'both',
      },
      {
        id: 'presentation',
        label: 'Presentation',
        control: 'select',
        options: [
          { value: 'list', label: 'List' },
          { value: 'summary', label: 'Summary' },
          { value: 'trend', label: 'Trend' },
          { value: 'distribution', label: 'Distribution' },
          { value: 'text', label: 'Text' },
          { value: 'image', label: 'Image' },
        ],
        default: 'list',
        showWhen: { input: 'template', equals: ['custom'] },
      },
      {
        id: 'columns',
        label: 'Columns',
        control: 'textarea',
        default: 'cpu|usage_average | CPU usage % (average) | avg | percent\ncpu|readyPct | CPU ready % (95th percentile) | percentile | percent\nmem|guest_usage | Guest memory % | current | percent\nconfig|hardware|num_Cpu | vCPU | property | 7004\nancestor(ClusterComputeResource) cpu|demandPct | Cluster CPU demand % | current | percent',
        hint: 'Attribute key | Label | Transformation | Unit | Kind (several object types only)',
        help: 'One column per row. The key is a metric or property key (keys keep their own |, cells are split on " | "). Put ancestor(Kind) or descendant(Kind) before the key to read it from a related object. Transformation is current, avg, max, min, sum, percentile (or "percentile 99"), forecast, first, last, timestamp, or property for a property.',
        options: [
          ...['current', 'avg', 'max', 'min', 'sum', 'percentile', 'forecast', 'first', 'last', 'timestamp', 'property'].map((value) => ({ value, label: value, group: 'Transformation' })),
          ...VIEW_UNITS.map((unit) => ({ ...unit, group: 'Unit' })),
          ...KIND_OPTIONS.map((kind) => ({ value: kind.value, label: kind.label, group: 'Kind' })),
        ],
        showWhen: { input: 'template', equals: ['custom'] },
      },
      { id: 'percentile', label: 'Percentile for "percentile" columns', control: 'number', default: 95, min: 1, max: 99, showWhen: { input: 'template', equals: ['custom'] } },
      { id: 'text_body', label: 'Text (HTML allowed)', control: 'textarea', default: '<b>How to read this dashboard</b><br>Select a cluster on the left.', showWhen: { input: 'presentation', equals: ['text'] } },
      {
        id: 'distribution_chart',
        label: 'Chart',
        control: 'select',
        options: [
          { value: 'bar-chart', label: 'Bar' },
          { value: 'pie-chart', label: 'Pie' },
          { value: 'donut-chart', label: 'Donut' },
        ],
        default: 'bar-chart',
        showWhen: { input: 'presentation', equals: ['distribution'] },
      },
      {
        id: 'buckets',
        label: 'Buckets',
        control: 'select',
        options: [
          { value: 'discrete', label: 'One per distinct value (for a property: version, model, state)' },
          { value: 'ranges', label: 'Ranges I give' },
          { value: 'equal', label: 'Equal-width buckets between a minimum and a maximum' },
        ],
        default: 'discrete',
        showWhen: { input: 'presentation', equals: ['distribution'] },
      },
      { id: 'bucket_ranges', label: 'Ranges', control: 'text', default: '0-2, 2-5, 5-100', hint: 'start-end, comma separated; coloured green to red in order', showWhen: { input: 'buckets', equals: ['ranges'] } },
      { id: 'bucket_count', label: 'Buckets', control: 'number', default: 10, min: 1, max: 50, showWhen: { input: 'buckets', equals: ['equal'] } },
      { id: 'bucket_min', label: 'From', control: 'number', default: 0, min: -1000000000, max: 1000000000, showWhen: { input: 'buckets', equals: ['equal'] } },
      { id: 'bucket_max', label: 'To', control: 'number', default: 100, min: -1000000000, max: 1000000000, showWhen: { input: 'buckets', equals: ['equal'] } },
      { id: 'trend_historical', label: 'Draw the historical data', control: 'toggle', default: true, showWhen: { input: 'presentation', equals: ['trend'] } },
      { id: 'trend_line', label: 'Draw a trend line', control: 'toggle', default: true, showWhen: { input: 'presentation', equals: ['trend'] } },
      { id: 'forecast_days', label: 'Forecast ahead (days)', control: 'number', default: 0, min: 0, max: 365, hint: '0 for no forecast', showWhen: { input: 'presentation', equals: ['trend'] } },
      {
        id: 'breakdown',
        label: 'Break down by',
        control: 'select',
        options: [
          { value: 'none', label: 'Nothing: one row per object' },
          { value: 'time', label: 'Period: one row per object per period' },
          { value: 'property', label: 'A property of the object' },
          { value: 'relationship', label: 'A related object (its parent cluster, host, …)' },
        ],
        default: 'none',
        showWhen: { input: 'template', equals: ['custom'] },
      },
      {
        id: 'breakdown_unit',
        label: 'Period',
        control: 'select',
        options: [
          { value: 'HOURS', label: 'Hour' },
          { value: 'DAYS', label: 'Day' },
          { value: 'WEEKS', label: 'Week' },
          { value: 'MONTHS', label: 'Month' },
        ],
        default: 'DAYS',
        showWhen: { input: 'breakdown', equals: ['time'] },
      },
      { id: 'breakdown_property', label: 'Property', control: 'text', default: 'summary|parentCluster', showWhen: { input: 'breakdown', equals: ['property'] } },
      { id: 'breakdown_kind', label: 'Related object type', control: 'combo', options: KIND_OPTIONS, default: 'ClusterComputeResource', showWhen: { input: 'breakdown', equals: ['relationship'] } },
      { id: 'breakdown_key', label: 'Its metric or property', control: 'text', default: 'badge|health', showWhen: { input: 'breakdown', equals: ['relationship'] } },
      {
        id: 'summary_row',
        label: 'Summary row',
        control: 'select',
        options: [
          { value: 'none', label: 'None' },
          { value: 'SUM', label: 'Total' },
          { value: 'AVG', label: 'Average' },
          { value: 'MIN', label: 'Lowest' },
          { value: 'MAX', label: 'Highest' },
          { value: 'COUNT', label: 'Count' },
        ],
        default: 'none',
        hint: 'List and summary views; a summary view uses Total when this is None',
      },
      { id: 'sort_column', label: 'Sort by column', control: 'text', default: '', placeholder: 'Unsorted', hint: 'A column label or key' },
      {
        id: 'sort_order',
        label: 'Sort order',
        control: 'select',
        options: [
          { value: 'descending', label: 'Highest first' },
          { value: 'ascending', label: 'Lowest first' },
        ],
        default: 'descending',
        showWhen: { input: 'sort_column', notEquals: [''] },
      },
      { id: 'top_n', label: 'Show only the top (rows)', control: 'number', default: 0, min: 0, max: 10000, hint: '0 for every row' },
      { id: 'page_size', label: 'Rows per page', control: 'number', default: 50, min: 5, max: 1000 },
      {
        id: 'time_mode',
        label: 'Time range',
        control: 'select',
        options: [
          { value: 'relative', label: 'The last N units' },
          { value: 'advanced', label: 'From the start of the previous N units to now' },
          { value: 'absolute', label: 'Between two dates' },
        ],
        default: 'relative',
      },
      { id: 'time_count', label: 'N', control: 'number', default: 24, min: 1, max: 1000, showWhen: { input: 'time_mode', notEquals: ['absolute'] } },
      {
        id: 'time_unit',
        label: 'Units',
        control: 'select',
        options: [
          { value: 'default', label: 'The view’s own (24 hours for a list, 30 days for a trend)' },
          { value: 'MINUTES', label: 'Minutes' },
          { value: 'HOURS', label: 'Hours' },
          { value: 'DAYS', label: 'Days' },
          { value: 'WEEKS', label: 'Weeks' },
          { value: 'MONTHS', label: 'Months' },
          { value: 'YEARS', label: 'Years' },
        ],
        default: 'default',
        showWhen: { input: 'time_mode', notEquals: ['absolute'] },
      },
      { id: 'time_from', label: 'From (YYYY-MM-DD)', control: 'text', default: '2026-01-01', showWhen: { input: 'time_mode', equals: ['absolute'] } },
      { id: 'time_to', label: 'To (YYYY-MM-DD)', control: 'text', default: '2026-06-30', showWhen: { input: 'time_mode', equals: ['absolute'] } },
      {
        id: 'subject_filter',
        label: 'Only objects where',
        control: 'textarea',
        default: '',
        hint: 'Type | Key | Condition | Value',
        help: 'All rows must hold. Type is metrics or properties; a number compares as a number, anything else as text.',
        options: [
          { value: 'properties', label: 'properties', group: 'Type' },
          { value: 'metrics', label: 'metrics', group: 'Type' },
          ...FILTER_CONDITIONS.map((c) => ({ value: c, label: c, group: 'Condition' })),
        ],
      },
      {
        id: 'visibility',
        label: 'Show it in',
        control: 'checklist',
        options: [
          { value: 'dashboard', label: 'Dashboards (the View widget)' },
          { value: 'report', label: 'Reports' },
          { value: 'details', label: 'Object details (Details tab)' },
        ],
        default: 'dashboard, report, details',
      },
      { id: 'tag_categories', label: 'Tag categories to show', control: 'text', default: 'Owner, Environment', hint: 'Adds the vSphere tag property as a column' },
      { id: 'include_tags', label: 'Include tag columns', control: 'toggle', default: false },
    ],
    automation: (values                 , name        )             => {
      const template = str(values, 'template', 'capacity');
      const custom = template === 'custom';
      const tags = listOf(str(values, 'tag_categories', ''));
      const includeTags = bool(values, 'include_tags', false);
      const findings            = [];
      const presentation = (custom ? str(values, 'presentation', 'list') : 'list')                ;
      const percentile = num(values, 'percentile', 95);

      let view              ;
      if (custom) {
        const parsed = parseViewColumns(str(values, 'columns', ''), percentile);
        for (const problem of parsed.problems) findings.push(error('vcfops.view.bad-column', problem, { source: SRC }));
        view = { name: str(values, 'view_name', 'Custom view'), kind: str(values, 'kind', 'VirtualMachine'), presentation, columns: parsed.columns, filter: 'none' };
      } else {
        view = viewTemplate(template, tags);
      }
      if (includeTags && template !== 'tags') {
        view = { ...view, columns: [...view.columns, ...tags.map((category) => ({ key: 'summary|tag', label: `Tag: ${category}`, property: true }))] };
      }

      // Breakdown: a first column the rows are grouped under.
      const breakdown = custom ? str(values, 'breakdown', 'none') : 'none';
      if (breakdown === 'time') view = { ...view, columns: [{ key: 'Interval Breakdown', label: 'Period', timeSegment: str(values, 'breakdown_unit', 'DAYS') }, ...view.columns] };
      if (breakdown === 'property') {
        const key = str(values, 'breakdown_property', 'summary|parentCluster');
        view = { ...view, columns: [{ key, label: key.split('|').pop() ?? key, property: true, sort: true }, ...view.columns.filter((c) => c.key !== key)] };
      }
      if (breakdown === 'relationship') {
        const kind = kindRef(str(values, 'breakdown_kind', 'ClusterComputeResource'));
        const key = str(values, 'breakdown_key', 'badge|health');
        view = { ...view, columns: [{ key, label: `${kindLabel(kind)}: ${key}`, related: { relation: 'ANCESTOR', kind }, sort: true, property: !/^(badge|cpu|mem|disk|net|virtualDisk|diskspace|capacity|OnlineCapacityAnalytics|cost|guestfilesystem|sys)\|/.test(key) }, ...view.columns] };
      }

      // Sort.
      const sortColumn = str(values, 'sort_column', '').trim();
      const sortOrder = str(values, 'sort_order', 'descending');
      if (sortColumn) {
        const index = view.columns.findIndex((c) => c.label.toLowerCase() === sortColumn.toLowerCase() || c.key === sortColumn);
        if (index < 0) findings.push(error('vcfops.view.sort-column', `Sort by "${sortColumn}": no column has that label or key.`, { remediation: `Columns: ${view.columns.map((c) => c.label).join(', ')}.`, source: SRC }));
        else view = { ...view, columns: view.columns.map((c, i) => ({ ...c, sort: i === index })) };
      }

      // Subjects.
      const subjects = [kindRef(view.kind), ...(custom ? listOf(str(values, 'more_kinds', '')).map(kindRef) : [])].filter((kind, index, all) => all.findIndex((other) => sameKind(other, kind)) === index);
      const relation = str(values, 'subject_relation', 'both')                           ;

      // Time.
      const timeMode = str(values, 'time_mode', 'relative')                               ;
      const timeUnit = str(values, 'time_unit', 'default');
      const defaults = defaultViewOptions(view);
      const dateOf = (text        )                     => (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? Date.parse(`${text}T00:00:00Z`) : undefined);
      const from = dateOf(str(values, 'time_from', ''));
      const to = dateOf(str(values, 'time_to', ''));
      if (timeMode === 'absolute') {
        if (from === undefined || to === undefined) findings.push(error('vcfops.view.bad-date', 'The time range needs two dates written YYYY-MM-DD.', { source: SRC }));
        else if (from >= to) findings.push(error('vcfops.view.bad-range', 'The time range ends before it starts.', { source: SRC }));
        findings.push(warning('vcfops.view.absolute-range', 'No exported view with a fixed date range was found, so the dates are written as startDate / endDate (milliseconds) with advancedTimeMode on.', { remediation: 'VERIFY after import: open the view, Time Settings, and check the dates; set them there if the editor shows a relative range.', source: SRC }));
      }
      const time =
        timeMode === 'absolute'
          ? { mode: timeMode, unit: 'DAYS', count: from !== undefined && to !== undefined && to > from ? Math.ceil((to - from) / 86400000) : 1, from, to: to !== undefined ? to + 86399999 : undefined }
          : { mode: timeMode, unit: timeUnit === 'default' ? defaults.time.unit : timeUnit, count: timeUnit === 'default' ? defaults.time.count : num(values, 'time_count', 24) };

      // Distribution buckets.
      const bucketMode = str(values, 'buckets', 'discrete')                                  ;
      const palette = ['8ABF5B', 'EACC58', 'ED891F', 'E4695E', 'DE3F30', '6870C4', '4ECAC2', '7D7DDE'];
      const ranges = str(values, 'bucket_ranges', '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part, index) => {
          const m = /^(-?\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(-?\d+(?:\.\d+)?)$/.exec(part);
          return m ? { start: Number(m[1]), end: Number(m[2]), color: palette[index % palette.length]  } : undefined;
        });
      const summaryRow = str(values, 'summary_row', 'none');
      const opts              = {
        ...defaults,
        description: '',
        subjects,
        relation,
        usages: listOf(str(values, 'visibility', '')),
        time,
        pageSize: num(values, 'page_size', 50),
        topN: num(values, 'top_n', 0),
        summary: summaryRow !== 'none' ? summaryRow : presentation === 'summary' ? 'SUM' : undefined,
        chart: str(values, 'distribution_chart', 'bar-chart')                        ,
        buckets: { mode: bucketMode, ranges: ranges.filter((r)                                                     => r !== undefined), count: num(values, 'bucket_count', 10), min: num(values, 'bucket_min', 0), max: num(values, 'bucket_max', 100) },
        trend: { historical: bool(values, 'trend_historical', true), line: bool(values, 'trend_line', true), forecastDays: num(values, 'forecast_days', 0) },
        filter: [],
        text: str(values, 'text_body', ''),
      };

      // Subject filter rows.
      const filter                     = [];
      for (const line of str(values, 'subject_filter', '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
        const [type = '', key = '', condition = '', value = ''] = cellsOf(line);
        const filterType = type.toLowerCase().startsWith('metric') ? 'metrics' : type.toLowerCase().startsWith('propert') ? 'properties' : undefined;
        const cond = condition.toUpperCase().replace(/\s+/g, '_');
        if (!filterType || !key || !FILTER_CONDITIONS.includes(cond) || value === '') {
          findings.push(error('vcfops.view.bad-filter', `"${line}" is not Type | Key | Condition | Value (type metrics or properties; condition ${FILTER_CONDITIONS.join(', ')}).`, { source: SRC }));
          continue;
        }
        filter.push({ filterType, key, condition: cond, value: /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value });
      }
      const finalOpts              = { ...opts, filter };

      // What the view is, in words, for the description the editor shows.
      const words = [
        view.filter && view.filter !== 'none' ? `Shows: ${view.filter}.` : '',
        filter.length > 0 ? `Only objects where ${filter.map((c) => `${c.key} ${c.condition.toLowerCase().replace(/_/g, ' ')} ${c.value}`).join(' and ')}.` : '',
        view.columns.some((c) => c.sort) ? `Sorted by ${view.columns.find((c) => c.sort) .label}, ${sortOrder === 'ascending' ? 'lowest' : 'highest'} first.` : '',
        finalOpts.topN > 0 ? `Top ${finalOpts.topN}.` : '',
      ].filter(Boolean);
      const described              = { ...finalOpts, description: words.length > 0 ? words.join(' ') : custom ? '' : ` Filter: ${view.filter}.` };

      // Findings.
      const data = view.columns.filter((c) => !c.timeSegment);
      if (presentation !== 'text' && presentation !== 'image' && data.length === 0) findings.push(error('vcfops.view.no-columns', 'A view with no columns shows the object names and nothing else.', { source: SRC }));
      for (const column of data) {
        const problem = column.key.startsWith('<REQUIRED') ? undefined : metricKeyProblem(column.key);
        if (problem) findings.push(error('vcfops.view.bad-key', `Column "${column.label}": the key "${column.key}" ${problem}.`, { source: SRC }));
        if (column.kind && !subjects.some((kind) => sameKind(kind, column.kind ))) {
          findings.push(error('vcfops.view.column-kind', `Column "${column.label}" is bound to ${kindText(column.kind)}, which is not one of the view’s object types (${subjects.map(kindText).join(', ')}).`, { remediation: 'Add the type under More object types, or clear the Kind cell.', source: SRC }));
        }
      }
      if (presentation === 'trend' && data.some((column) => column.property)) {
        findings.push(warning('vcfops.view.trend-property', 'A trend view over a property draws a flat line: properties are not time series.', { remediation: 'Use metrics in a trend view; put properties in a list.', source: SRC }));
      }
      if (presentation === 'trend' && data.some((c) => c.transform && c.transform !== 'CURRENT')) {
        findings.push(info('vcfops.view.trend-transform', 'A trend view draws the history, trend line and forecast set below for every column; the per-column transformations are not used.', { source: SRC }));
      }
      if (presentation === 'trend' && !finalOpts.trend.historical && !finalOpts.trend.line && finalOpts.trend.forecastDays === 0) {
        findings.push(error('vcfops.view.trend-empty', 'The trend view draws neither the history, a trend line nor a forecast.', { source: SRC }));
      }
      if (presentation === 'distribution' && data.length > 1) findings.push(warning('vcfops.view.distribution-columns', 'A distribution view plots one value; only the first column is used.', { source: SRC }));
      if (presentation === 'distribution' && data[0]?.property && bucketMode !== 'discrete') {
        findings.push(warning('vcfops.view.distribution-property', `"${data[0].label}" is a property, bucketed as numbers, so the chart opens with "No data to display".`, { remediation: 'Use "One per distinct value" buckets for a property (the fix for the same fault in sentania-labs DEF-012).', source: SRC }));
      }
      if (presentation === 'distribution' && bucketMode === 'ranges' && (finalOpts.buckets.ranges.length === 0 || ranges.some((r) => r === undefined))) {
        findings.push(error('vcfops.view.bad-ranges', `"${str(values, 'bucket_ranges', '')}" is not a list of start-end ranges.`, { source: SRC }));
      }
      if (presentation === 'distribution' && bucketMode === 'equal' && finalOpts.buckets.min >= finalOpts.buckets.max) findings.push(error('vcfops.view.bad-buckets', 'The buckets end before they start.', { source: SRC }));
      if (presentation !== 'trend' && data.some((c) => c.transform === 'FORECAST')) {
        findings.push(warning('vcfops.view.forecast-column', 'Forecast is written on a list column with forecastDays; the exports seen use it only in trend views.', { remediation: 'VERIFY the column in the editor after import, or make the view a trend with a forecast.', source: SRC }));
      }
      const aggregating = data.some((c) => c.transform && !['CURRENT', 'TIMESTAMP'].includes(c.transform));
      if (aggregating && timeMode === 'relative' && timeUnit === 'default' && (presentation === 'list' || presentation === 'summary')) {
        findings.push(info('vcfops.view.window', 'Averages, maximums and percentiles are taken over the view’s time range, 24 hours here.', { remediation: 'Set the time range to the window you mean, such as 30 days for right-sizing.', source: SRC }));
      }
      if (finalOpts.usages.filter((u) => ['dashboard', 'report', 'details'].includes(u)).length === 0) {
        findings.push(error('vcfops.view.invisible', 'The view is shown nowhere: tick dashboards, reports or object details.', { source: SRC }));
      }
      if (presentation === 'text' && !finalOpts.text.trim()) findings.push(error('vcfops.view.no-text', 'A text view with no text.', { source: SRC }));
      if (presentation === 'image') {
        findings.push(warning('vcfops.view.image', 'The picture is not in the XML yet: run embed-image.sh <picture.png> before importing; import-view.sh refuses until then.', { source: SRC }));
      }
      if (finalOpts.topN > 0 && presentation !== 'list' && presentation !== 'summary') findings.push(info('vcfops.view.top-n', 'Top-N applies to list and summary views.', { source: SRC }));
      if (subjects.length > 1 && data.every((c) => !c.kind)) {
        findings.push(info('vcfops.view.multi-subject', 'Every column reads every object type; a key one type does not have shows a dash on its rows.', { remediation: 'Name the type in a column’s Kind cell to show it only on that type’s rows.', source: SRC }));
      }
      for (const kind of [...subjects, ...data.flatMap((c) => (c.related ? [c.related.kind] : []))]) {
        if (!KINDS.some((k) => k.seen && sameKind(kindRef(k.value), kind))) {
          findings.push(info('vcfops.view.kind-unverified', `${kindText(kind)} is not a kind seen in an exported view.`, { remediation: 'VERIFY the adapter and object type keys on an object’s details (or GET /suite-api/api/adapterkinds/{adapterKind}/resourcekinds).', source: SRC }));
        }
      }
      if (data.some((column) => column.key === 'summary|tag')) {
        findings.push(info('vcfops.view.tag-property', 'Tag columns use the property summary|tag, which holds every tag on the object as one string.', { remediation: 'VERIFY the key and the value format on a tagged VM’s property list. A per-category column needs a filter on that string, not a separate key.', source: SRC }));
      }
      if (data.some((column) => column.key.startsWith('<REQUIRED'))) {
        findings.push(warning('vcfops.view.required-key', 'A column key is still <REQUIRED>, so the import script will refuse to run.', { remediation: 'Find the key on an object’s metric or property list in your release and put it in the XML.', source: SRC }));
      }

      const content = viewXml(view, described);
      const kindsText = subjects.map(kindText).join(', ');
      const presentationLabel = presentation === 'distribution' ? `${finalOpts.chart.replace('-chart', '')} distribution` : presentation;
      const embed = presentation === 'image' ? { 'embed-image.sh': embedImageScript() } : {};
      const verify = [
        ...(presentation === 'summary' ? ['a summary view is written as a list-view provider with Presentation "summary" and a summaryInfos aggregation; no summary view was in the exports read. Open it in the editor after import and check it draws.'] : []),
        ...(presentation === 'image' ? ['the picture is written as one line of base64 in <Source>; the exports wrap it at 76 characters. If the editor shows no picture, re-add it there.'] : []),
        ...(breakdown === 'property' || breakdown === 'relationship' ? ['the view editor’s Group By setting is in no export read, so the breakdown is written as the first column, sorted. Set Group By on that column in the editor if you want grouped rows.'] : []),
        ...(sortColumn ? [`exports carry which column sorts (sortCriteria) but not the direction; check it sorts ${sortOrder === 'ascending' ? 'lowest' : 'highest'} first, and flip it in the editor if not.`] : []),
        ...(finalOpts.topN > 0 ? [`top ${finalOpts.topN} is written as listTopResultSize (every export has -1, "all"); check the view shows ${finalOpts.topN} rows.`] : []),
      ];
      return {
        platform: PLATFORM,
        title: `View "${view.name}" — ${presentationLabel} of ${kindsText}, ${data.length} columns`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Imported once; used whenever a dashboard widget or a report renders it.', worstCase: 'every dashboard refresh that shows it' },
        scope: {
          what: `One view definition, id ${viewIdOf(view.name)}, over ${kindsText} objects${relation === 'descendant' ? ' below the object it is run on' : relation === 'self' ? ' — only the object it is run on' : ''}.`,
          decidedBy: [
            `Object types ${kindsText}; ${relation === 'both' ? 'it runs on one of them, or lists them below any object' : relation === 'descendant' ? 'it lists them below the object it is run on' : 'it runs only on one of them'}.`,
            filter.length > 0 ? `Filter: ${described.description}` : `Filter: ${view.filter}.`,
            'Whatever object the dashboard or report runs it against — the view itself has no fixed scope.',
          ],
          ifWrong: 'With --overwrite, a view with the same name or id is replaced, and a report or dashboard that used the old columns now shows the new ones; the old view is in the pre-import-backup zip. Without --overwrite the script refuses.',
        },
        guardrails: [
          { rule: 'The id comes from the name', because: 'Re-importing an edited view replaces it rather than creating a second one with the same title, which is how estates end up with four "VM Inventory" views.' },
          { rule: 'Every column key, transformation, unit, filter row and bucket range is checked before anything is written', because: 'A misspelt key or a property bucketed as a number imports cleanly and shows an empty column or "No data to display" forever.' },
          { rule: 'import-view.sh stops while the XML holds <REQUIRED>', because: 'A view with a placeholder column key, or an image view with no picture, imports cleanly and shows nothing.' },
          { rule: '--dry-run builds and lists the zip and sends nothing', because: 'The content-zip layout comes from real exports rather than a published specification; a --dry-run first is for comparing it with an export-reference.sh export.' },
          { rule: 'When it imports, the script first exports the existing VIEW_DEFINITIONS content to pre-import-backup-<time>.zip and refuses to import when a view with the same name or id is already there, unless --overwrite is given', because: 'The import API overwrites by default (force defaults to true), and somebody’s hand-edited copy would be gone with no copy kept.' },
          { rule: 'The import is sent with force=false unless --overwrite', because: 'Without it the API replaces whatever matches, which is the documented default.' },
          { rule: 'The script follows the import by the id its POST returned and exits 1 unless it reaches FINISHED with nothing failed or skipped, or when it times out', because: 'Reading the "last import" status can show an earlier import, and a FAILED import that exits 0 is taken as done.' },
        ],
        dryRun: ['Run import-view.sh --dry-run first: it builds the content package, lists it and sends nothing.', 'Drop import/view.zip on the VCF Ops content page: it reads ViewDef content and lists the view with its subject type.'],
        undo: ['Delete the view under Views > Manage. Delete any dashboard widget or report section that uses it first, or they show an error.', 'If --overwrite replaced a view, import the pre-import-backup-<time>.zip the script wrote to put the previous one back.'],
        told: ['Nobody. It is a definition.'],
        requires: ['zip, unzip, jq and curl.', 'An account allowed to import content.', ...(presentation === 'image' ? ['The picture (PNG or JPEG) beside the scripts, and base64.'] : [])],
        files: {
          'import/view.zip/content.xml': content,
          'import/view.xml': content,
          ...contentPackage({ 'views.zip/content.xml': content }, { views: 1 }),
          'import-view.sh': contentImportScript({ what: `the view "${view.name}"`, contentType: 'VIEW_DEFINITIONS', needles: [`<Title>${xml(view.name)}</Title>`, viewIdOf(view.name)] }),
          ...embed,
          'export-reference.sh': exportReferenceScript('VIEW_DEFINITIONS'),
          'IMPORT.md': importMd({
            title: `the view "${view.name}"`,
            steps: [
              ...(presentation === 'image'
                ? [{ heading: 'First, the picture', files: ['embed-image.sh'], how: ['./embed-image.sh picture.png — writes the picture into import/view.xml, import/view.zip and the content package, as base64. Run it once; import-view.sh refuses while the placeholder is there.'] }]
                : []),
              {
                heading: 'The view',
                files: ['import/view.zip'],
                how: ['Views → Manage → ⋯ → Import, and choose import/view.zip — a zip holding content.xml, as a view export is.', `The view keeps id ${viewIdOf(view.name)}, which is the id the dashboard and report blueprints refer to.`],
                verify: ['import/view.xml is the same content.xml as a bare file, for dialogs that take the XML on its own.', ...verify],
              },
              contentStep('VIEW_DEFINITIONS', 'import-view.sh'),
            ],
            intro: IMPORT_INTRO,
            sources: CONTENT_SOURCES,
          }),
        },
        notes: [
          CONTENT_IMPORT_NOTE,
          'DASHBOARDS, VIEW_DEFINITIONS and REPORT_DEFINITIONS are in the contentTypes enum of POST /content/operations/export in the VCF Operations API reference; the backup export uses scope CUSTOM with just that type.',
          'Element and property names are the ones real exports carry: list-view / trend-view / distribution-view providers; Presentation list, line-chart, bar-chart, pie-chart, donut-chart, text and image; per-column transformations CURRENT, AVG, MAX, MIN, SUM, PERCENTILE (with percentile), FORECAST (with forecastDays), FIRST, LAST and TIMESTAMP; preferredUnitId; sortCriteria; relatedRelationType; the Interval Breakdown column; summaryInfos; buckets-control DISCRETE and SIMPLEMAXMIN; the SubjectType filter JSON (brockpeterson/operations_dashboards, sentania-labs/vcf-content-factory working_views.xml and view_column_wire_format.md).',
          ...verify.map((line) => `VERIFY: ${line}`),
        ],
        findings,
      };
    },
  }),
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_report',
    platform: PLATFORM,
    label: 'A report from views and dashboards, on a schedule',
    group: 'Dashboards and reports',
    description:
      'A report definition made of views and dashboards in the order given, each in landscape or portrait, with or without a cover page, a table of contents and a page footer, in PDF, CSV or both — imported as content — and then scheduled daily, weekly or monthly (every N days, weeks or months, on the weekdays or the day of the month chosen) with POST /reportdefinitions/{id}/schedules: run against one object or a custom group, and mailed to a team address through the outbound email instance named. Views and dashboards are referred to by the same name-derived ids the view and dashboard blueprints write.',
    inputs: [
      { id: 'report_name', label: 'Report name', control: 'text', default: 'Monthly capacity and reclamation' },
      {
        id: 'content',
        label: 'Content, in order',
        control: 'textarea',
        default: 'view | Cluster capacity overview | Landscape | yes\nview | Reclamation | Landscape | yes\ndashboard | Cluster capacity overview | Landscape | ',
        hint: 'Type | Name | Orientation | Colour list cells',
        help: 'One section per row: a view or a dashboard by name, as the view and dashboard blueprints write them (or id:<uuid> for one made by hand). Orientation left empty takes the report’s own. "Colour list cells" applies the view’s thresholds to its cells in the PDF.',
        options: [
          { value: 'view', label: 'View', group: 'Type' },
          { value: 'dashboard', label: 'Dashboard', group: 'Type' },
          { value: 'Landscape', label: 'Landscape', group: 'Orientation' },
          { value: 'Portrait', label: 'Portrait', group: 'Orientation' },
          { value: 'yes', label: 'Yes', group: 'Colour list cells' },
          { value: 'no', label: 'No', group: 'Colour list cells' },
        ],
      },
      { id: 'kind', label: 'Object type it reports on', control: 'combo', options: KIND_OPTIONS, default: 'ClusterComputeResource', hint: 'Or Adapter/Kind' },
      {
        id: 'subject_relation',
        label: 'Runs on',
        control: 'select',
        options: [
          { value: 'both', label: 'That type, or anything above it (a datacenter, vCenter, the world)' },
          { value: 'descendant', label: 'Only objects above that type' },
          { value: 'self', label: 'Only objects of that type' },
        ],
        default: 'both',
      },
      {
        id: 'subject_mode',
        label: 'Scheduled for',
        control: 'select',
        options: [
          { value: 'object', label: 'One object, by name' },
          { value: 'group', label: 'A custom group, by name' },
        ],
        default: 'object',
      },
      { id: 'subject_name', label: 'Object or group name', control: 'text', default: 'vSphere World' },
      { id: 'cover_page', label: 'Cover page', control: 'toggle', default: true },
      { id: 'toc', label: 'Table of contents', control: 'toggle', default: true },
      { id: 'footer', label: 'Page footer (page numbers, date)', control: 'toggle', default: true },
      {
        id: 'orientation',
        label: 'Orientation',
        control: 'select',
        options: [
          { value: 'Landscape', label: 'Landscape' },
          { value: 'Portrait', label: 'Portrait' },
        ],
        default: 'Landscape',
        hint: 'For sections that do not set their own',
      },
      {
        id: 'formats',
        label: 'Formats',
        control: 'select',
        options: [
          { value: 'both', label: 'PDF and CSV' },
          { value: 'pdf', label: 'PDF' },
          { value: 'csv', label: 'CSV' },
        ],
        default: 'both',
      },
      {
        id: 'cadence',
        label: 'How often',
        control: 'select',
        options: [
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
          { value: 'monthly', label: 'Monthly' },
        ],
        default: 'monthly',
      },
      { id: 'every', label: 'Every (days, weeks or months)', control: 'number', default: 1, min: 1, max: 99, hint: '2 for every other week' },
      {
        id: 'weekdays',
        label: 'On',
        control: 'checklist',
        options: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((day) => ({ value: day, label: day.charAt(0) + day.slice(1).toLowerCase() })),
        default: 'MONDAY',
        showWhen: { input: 'cadence', equals: ['weekly'] },
      },
      { id: 'day_of_month', label: 'Day of the month', control: 'number', default: 1, min: 1, max: 31, showWhen: { input: 'cadence', equals: ['monthly'] } },
      { id: 'start_time', label: 'At (HH:MM, GMT)', control: 'text', default: '07:00', hint: 'Schedules made through the API run in GMT' },
      { id: 'start_date', label: 'Starting (YYYY-MM-DD)', control: 'text', default: '', placeholder: 'The day it is scheduled' },
      { id: 'email_instance', label: 'Outbound email instance', control: 'text', default: '', placeholder: 'The default one', hint: 'Its name under Outbound Settings' },
      { id: 'recipients', label: 'Send to', control: 'text', default: 'platform-team@example.com', hint: 'Comma separated' },
    ],
    automation: (values                 , name        )             => {
      const reportName = str(values, 'report_name', 'Report');
      const kind = kindRef(str(values, 'kind', 'ClusterComputeResource'));
      const relation = str(values, 'subject_relation', 'both');
      const subjectMode = str(values, 'subject_mode', 'object');
      const subjectName = str(values, 'subject_name', 'vSphere World').trim();
      const cover = bool(values, 'cover_page', true);
      const toc = bool(values, 'toc', true);
      const footer = bool(values, 'footer', true);
      const orientation = str(values, 'orientation', 'Landscape');
      const formats = str(values, 'formats', 'both');
      const cadence = str(values, 'cadence', 'monthly');
      const every = Math.max(1, num(values, 'every', 1));
      const weekdays = listOf(str(values, 'weekdays', '')).map((day) => day.toUpperCase());
      const dayOfMonth = num(values, 'day_of_month', 1);
      const startTime = str(values, 'start_time', '07:00').trim();
      const startDate = str(values, 'start_date', '').trim();
      const emailInstance = str(values, 'email_instance', '').trim();
      const recipients = listOf(str(values, 'recipients', ''));
      const base = slugOf(name || reportName, 'report');
      const reportId = stableId(`report:${reportName}`);
      const time = /^(\d{1,2}):(\d{2})$/.exec(startTime);

      const findings            = [];
      const sections = parseReportContent(str(values, 'content', ''), orientation);
      for (const problem of sections.problems) findings.push(error('vcfops.report.bad-section', problem, { source: SRC }));
      const views = sections.rows.filter((row) => row.type === 'View');
      const dashboards = sections.rows.filter((row) => row.type === 'Dashboard');
      if (sections.rows.length === 0) findings.push(error('vcfops.report.no-views', 'A report with no views or dashboards is a cover page.', { source: SRC }));
      if (recipients.length === 0) findings.push(error('vcfops.report.no-recipient', 'No recipients, so the schedule generates a report nobody receives.', { source: SRC }));
      const badAddress = recipients.filter((address) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address));
      if (badAddress.length > 0) findings.push(error('vcfops.report.bad-address', `${badAddress.join(', ')} ${badAddress.length === 1 ? 'is not an email address' : 'are not email addresses'}.`, { source: SRC }));
      if (sections.rows.length > 8) findings.push(warning('vcfops.report.long', `${sections.rows.length} sections in one report.`, { remediation: 'Nobody reads past page ten. Split it by audience.', source: SRC }));
      if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) findings.push(error('vcfops.report.bad-time', `"${startTime}" is not a 24-hour HH:MM time.`, { source: SRC }));
      if (startDate && (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || Number.isNaN(Date.parse(`${startDate}T00:00:00Z`)))) findings.push(error('vcfops.report.bad-date', `"${startDate}" is not a YYYY-MM-DD date.`, { source: SRC }));
      if (cadence === 'weekly' && weekdays.length === 0) findings.push(error('vcfops.report.no-day', 'A weekly schedule with no day never runs.', { source: SRC }));
      if (cadence === 'monthly' && dayOfMonth > 28) {
        findings.push(warning('vcfops.report.short-month', `Day ${dayOfMonth} does not exist in every month.`, { remediation: 'Use day 28 or earlier, or VERIFY on your release whether a short month runs it on its last day or skips it.', source: SRC }));
      }
      if (cadence === 'daily' && every === 1) findings.push(info('vcfops.report.daily', 'A report every day is read for a week and then filtered. Weekly is usually the useful rhythm.', { source: SRC }));
      if (!subjectName) findings.push(error('vcfops.report.no-subject', 'The schedule needs an object or group to run the report for.', { source: SRC }));
      if (dashboards.length > 0 && formats === 'csv') {
        findings.push(warning('vcfops.report.csv-dashboard', 'A dashboard section has no CSV form: a CSV-only report leaves it out.', { remediation: 'Add PDF, or drop the dashboard section.', source: SRC }));
      }
      if (dashboards.length > 0) {
        findings.push(info('vcfops.report.dashboard', 'A dashboard section prints the dashboard as it stands; a widget that waits for a selection in another prints empty.', { remediation: 'Give dashboards that go in reports self-providing widgets.', source: SRC }));
      }
      if (sections.rows.some((row) => !row.byId)) {
        findings.push(info('vcfops.report.derived-ids', 'Views and dashboards are referred to by the ids their blueprints derive from their names; one made by hand has its own id.', { remediation: 'For one made by hand, export it (Content Management) and write id:<its id> in the Name cell.', source: SRC }));
      }

      const formatList = formats === 'both' ? ['PDF', 'CSV'] : [formats.toUpperCase()];
      // As a Reports → Export writes it (sentania-labs reports_api_surface and a
      // VCF Operations 9 export): ReportDef with isTenant, Title, Description,
      // SubjectType, Sections of ContentType / ContentKey (a view section's key
      // is the view id, a dashboard section's the dashboard id), per-section
      // ContentOrientation and ContentFormatting, then Settings.
      const subjectTypes = [
        ...(relation === 'self' ? [] : [`            <SubjectType adapterKind="${xml(kind.adapterKind)}" resourceKind="${xml(kind.resourceKind)}" type="descendant"/>`]),
        ...(relation === 'descendant' ? [] : [`            <SubjectType adapterKind="${xml(kind.adapterKind)}" resourceKind="${xml(kind.resourceKind)}" type="self"/>`]),
      ];
      const reportXml = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Content>',
        '    <Reports>',
        `        <ReportDef id="${reportId}">`,
        '            <isTenant>false</isTenant>',
        `            <Title>${xml(reportName)}</Title>`,
        `            <Description>${xml(`${sections.rows.map((row) => row.name).join(', ')}.`)}</Description>`,
        ...subjectTypes,
        '            <Sections>',
        ...(cover ? ['                <Section>', '                    <ContentType>CoverPage</ContentType>', '                    <ContentKey>COVER_PAGE</ContentKey>', '                </Section>'] : []),
        ...(toc ? ['                <Section>', '                    <ContentType>TableOfContents</ContentType>', '                    <ContentKey>TABLE_OF_CONTENTS</ContentKey>', '                </Section>'] : []),
        ...sections.rows.flatMap((row) => [
          '                <Section>',
          `                    <ContentType>${row.type}</ContentType>`,
          `                    <ContentKey>${xml(row.id)}</ContentKey>`,
          `                    <ContentOrientation>${row.orientation}</ContentOrientation>`,
          ...(row.type === 'View' ? ['                    <ContentFormatting>', `                        <ColorizeListView>${row.colorize}</ColorizeListView>`, '                    </ContentFormatting>'] : []),
          '                </Section>',
        ]),
        '            </Sections>',
        '            <Settings>',
        `                <ShowPageFooter>${footer}</ShowPageFooter>`,
        ...formatList.map((format) => `                <OutputFormat>${format.toLowerCase()}</OutputFormat>`),
        '            </Settings>',
        '        </ReportDef>',
        '    </Reports>',
        '</Content>',
        '',
      ].join('\n');

      // Fields as the schedule API takes them (the same body "Email a capacity
      // report on a schedule" sends). No network-share path: publishing reports to
      // a share was removed in 9.1.
      const schedule = {
        reportDefinitionId: '<set by schedule-report.sh from the report name>',
        resourceId: [`<set by schedule-report.sh from the ${subjectMode === 'group' ? 'custom group' : 'object'} name>`],
        reportScheduleType: cadence === 'daily' ? 'DAILY' : cadence === 'weekly' ? 'WEEKLY' : 'MONTHLY',
        recurrence: every,
        ...(cadence === 'weekly' ? { daysOfTheWeek: weekdays } : {}),
        ...(cadence === 'monthly' ? { dayOfTheMonth: dayOfMonth } : {}),
        startDate: startDate || '<set by schedule-report.sh: today>',
        startHour: time ? Number(time[1]) : 7,
        startMinute: time ? Number(time[2]) : 0,
        emailAddresses: recipients,
        ...(emailInstance ? { emailPluginId: `<set by schedule-report.sh from the outbound instance "${emailInstance}">` } : {}),
      };

      const api = `https://\${VCFOPS_HOST}/suite-api/api`;
      const scheduleScript = [
        '#!/usr/bin/env bash',
        `# Schedule the report "${reportName}" once it has been imported: ${cadence}, for`,
        `# the ${subjectMode === 'group' ? 'custom group' : 'object'} "${subjectName}", mailed to ${recipients.join(', ') || 'nobody'}.`,
        '#',
        '# The report, the object or group and the email instance are looked up by name.',
        '# It posts the schedule when run; --dry-run prints the body and sends nothing.',
        '# A schedule for the same object already on the report is reported and not',
        '# duplicated; --again adds one anyway. Schedules made through the API run in GMT.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'DRY_RUN=0; AGAIN=0',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    --dry-run) DRY_RUN=1 ;;',
        '    --again) AGAIN=1 ;;',
        '    *) echo "Unknown argument $arg. Use --dry-run to preview, --again to add a second schedule." >&2; exit 2 ;;',
        '  esac',
        'done',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        `get() { curl -sS -f -G "${api}/$1" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" "\${@:2}"; }`,
        '',
        '# The imported definition, by name rather than by the id in the XML: an import',
        '# may assign its own.',
        `DEF_ID=$(get reportdefinitions --data-urlencode 'name=${sq(reportName)}' | jq -r --arg n '${sq(reportName)}' '[.reportDefinitions[]? | select(.name == $n) | .id] | if length == 1 then .[0] else empty end')`,
        `[[ -n "$DEF_ID" ]] || { echo "Expected exactly one report definition named '${sq(reportName)}'. Import it first, or remove the duplicate." >&2; exit 2; }`,
        '',
        subjectMode === 'group'
          ? `SUBJECT_ID=$(get resources/groups --data-urlencode pageSize=10000 | jq -r --arg n '${sq(subjectName)}' '[.groups[]? | select(.resourceKey.name == $n) | .id] | if length == 1 then .[0] else empty end')`
          : `SUBJECT_ID=$(get resources --data-urlencode 'name=${sq(subjectName)}' --data-urlencode pageSize=1000 | jq -r --arg n '${sq(subjectName)}' '[.resourceList[]? | select(.resourceKey.name == $n) | .identifier] | if length == 1 then .[0] else empty end')`,
        `[[ -n "$SUBJECT_ID" ]] || { echo "Expected exactly one ${subjectMode === 'group' ? 'custom group' : 'object'} named '${sq(subjectName)}'." >&2; exit 2; }`,
        ...(emailInstance
          ? [
              `PLUGIN=$(get alertplugins | jq -c --arg n '${sq(emailInstance)}' '[(.notificationPluginInstances[]?, .pluginInstances[]?) | select(.name == $n)] | .[0] // empty')`,
              `[[ -n "$PLUGIN" ]] || { echo "No outbound instance named '${sq(emailInstance)}'. Create it with \\"An outbound plugin instance\\" first." >&2; exit 2; }`,
              'PLUGIN_ID=$(jq -r \'.pluginId\' <<<"$PLUGIN")',
              'if [[ "$(jq -r \'.pluginTypeId // ""\' <<<"$PLUGIN")" != "StandardEmailPlugin" ]]; then echo "The outbound instance is not a Standard Email plugin; reports go by email." >&2; exit 2; fi',
              'if [[ "$(jq -r \'.enabled // true\' <<<"$PLUGIN")" == "false" ]]; then echo "The outbound instance is disabled; enable it (and send its test) first." >&2; exit 2; fi',
            ]
          : ['PLUGIN_ID=""']),
        startDate ? `START='${sq(startDate)}'` : 'START=$(date -u +%Y-%m-%d)',
        '',
        'if (( ! AGAIN )) && get "reportdefinitions/${DEF_ID}/schedules" | jq -e --arg r "$SUBJECT_ID" \'[.. | objects | select((.resourceId? // []) | index($r))] | length > 0\' >/dev/null; then',
        `  echo "The report already has a schedule for '${sq(subjectName)}'. Nothing was changed; run with --again to add another." >&2`,
        '  exit 1',
        'fi',
        `body=$(jq --arg d "$DEF_ID" --arg r "$SUBJECT_ID" --arg p "$PLUGIN_ID" --arg s "$START" '.reportDefinitionId = $d | .resourceId = [$r] | .startDate = $s | (if $p != "" then .emailPluginId = $p else del(.emailPluginId) end)' "$HERE/${base}-schedule.json")`,
        'if grep -q "<REQUIRED" <<<"$body"; then echo "The schedule still has a <REQUIRED> value in it." >&2; exit 2; fi',
        'if (( DRY_RUN )); then',
        `  echo "DRY RUN: would POST to ${api}/reportdefinitions/\${DEF_ID}/schedules:"`,
        '  echo "$body"',
        '  echo "Dry run: nothing was changed. Run it without --dry-run to apply."',
        '  exit 0',
        'fi',
        `echo "$body" | curl -sS -f -X POST "${api}/reportdefinitions/\${DEF_ID}/schedules" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -H "Content-Type: application/json" --data @- | jq -c '{id: (.id // .scheduleId // null)}'`,
        '# Undo: GET .../reportdefinitions/${DEF_ID}/schedules, then DELETE .../schedules/{scheduleId}.',
        '',
      ].join('\n');

      const period = cadence === 'daily' ? 'day' : cadence === 'weekly' ? 'week' : 'month';
      const whenText = `${every > 1 ? `every ${every} ${period}s` : `every ${period}`}${cadence === 'weekly' ? ` on ${weekdays.map((day) => day.charAt(0) + day.slice(1).toLowerCase()).join(', ')}` : ''}${cadence === 'monthly' ? ` on day ${dayOfMonth}` : ''}, at ${startTime} GMT`;
      const sectionNames = sections.rows.map((row) => `${row.type === 'Dashboard' ? 'dashboard ' : ''}${row.name}`);

      return {
        platform: PLATFORM,
        title: `Report "${reportName}" — ${views.length} views${dashboards.length > 0 ? `, ${dashboards.length} dashboards` : ''}, ${formatList.join(' and ')}, ${cadence}`,
        effect: 'reversible',
        trigger: { kind: 'schedule', detail: `${whenText} — schedules made through the API run in GMT`, worstCase: cadence === 'weekly' ? `on each of ${weekdays.length} day(s) a week` : `once a ${period}` },
        scope: {
          what: `The report definition "${reportName}", run for the ${subjectMode === 'group' ? 'custom group' : 'object'} "${subjectName}", mailed to ${recipients.join(', ') || 'nobody'}${emailInstance ? ` through the outbound instance "${emailInstance}"` : ''}.`,
          decidedBy: [`The sections in it, in order: ${sectionNames.join(', ') || 'none'}.`, `The ${subjectMode === 'group' ? 'custom group' : 'object'} "${subjectName}" — one per schedule; the views run against its ${kindLabel(kind)} ${relation === 'self' ? 'self' : 'descendants'}.`, `The email instance that sends it: ${emailInstance || 'the default one'}.`],
          ifWrong: 'A report about the wrong object that looks plausible, mailed on schedule and acted on.',
        },
        guardrails: [
          { rule: 'schedule-report.sh refuses unless exactly one definition, and exactly one object or group, has the name given', because: 'Scheduling the older of two same-named reports, or the wrong same-named cluster, sends plausible numbers about the wrong thing to people who will not notice.' },
          { rule: 'It refuses when the report already has a schedule for that object, unless --again', because: 'The schedule API is not idempotent: a second run mails everything twice.' },
          { rule: 'The email instance must be a Standard Email instance and enabled', because: 'A schedule on a disabled or non-email instance runs and delivers nothing, and nobody is told.' },
          { rule: 'Every section row, the time, the date and the addresses are checked before anything is written', because: 'A report section naming a view that does not exist does not import, and a bad address is a bounce nobody reads.' },
          { rule: '--dry-run previews the import and the schedule without sending them', because: 'The content-zip layout comes from real exports rather than a published specification; compare it with an export-reference.sh export before sending.' },
          { rule: 'When it imports, the script first exports the existing REPORT_DEFINITIONS content to pre-import-backup-<time>.zip and refuses to import when a report with the same name or id is already there, unless --overwrite is given', because: 'The import API overwrites by default (force defaults to true), and somebody’s hand-edited copy would be gone with no copy kept.' },
          { rule: 'The import is sent with force=false unless --overwrite', because: 'Without it the API replaces whatever matches, which is the documented default.' },
          { rule: 'The script follows the import by the id its POST returned and exits 1 unless it reaches FINISHED with nothing failed or skipped, or when it times out', because: 'Reading the "last import" status can show an earlier import, and a FAILED import that exits 0 is taken as done.' },
        ],
        dryRun: ['Run import-report.sh --dry-run and schedule-report.sh --dry-run first.', 'After importing, run the report once by hand against the same object and read it before scheduling.'],
        undo: [
          'GET /suite-api/api/reportdefinitions/{id}/schedules, then DELETE /suite-api/api/reportdefinitions/{id}/schedules/{scheduleId}.',
          'Delete the report definition under Reports > Manage.',
          'If --overwrite replaced a report definition, import the pre-import-backup-<time>.zip the script wrote to put the previous one back.',
        ],
        told: recipients.length > 0 ? [`${recipients.join(', ')}, ${whenText}.`] : ['Nobody.'],
        requires: [
          ...(views.length > 0 ? [`The views (${views.map((row) => row.name).join(', ')}) imported first, from "A view for dashboards and reports" with the same names.`] : []),
          ...(dashboards.length > 0 ? [`The dashboards (${dashboards.map((row) => row.name).join(', ')}) imported first, from "A dashboard, as importable JSON" with the same names.`] : []),
          `A Standard Email outbound instance that works${emailInstance ? ` ("${emailInstance}")` : ''}: send a test from it first.`,
          'zip, unzip, jq and curl.',
        ],
        files: {
          'import/report.zip/content.xml': reportXml,
          'import/report.xml': reportXml,
          ...contentPackage({ 'reports.zip/content.xml': reportXml }, { reports: 1 }),
          [`${base}-schedule.json`]: `${JSON.stringify(schedule, null, 2)}\n`,
          'import-report.sh': contentImportScript({ what: `the report "${reportName}"`, contentType: 'REPORT_DEFINITIONS', needles: [`<Title>${xml(reportName)}</Title>`, reportId] }),
          'schedule-report.sh': scheduleScript,
          'export-reference.sh': exportReferenceScript('REPORT_DEFINITIONS'),
          'IMPORT.md': importMd({
            title: `the report "${reportName}"`,
            intro: IMPORT_INTRO,
            steps: [
              {
                heading: 'First, what it is made of',
                files: [],
                how: [
                  ...(views.length > 0 ? [`The views, each from "A view for dashboards and reports" with the same name (import/view.zip): ${views.map((row) => row.name).join(', ')}.`] : []),
                  ...(dashboards.length > 0 ? [`The dashboards, each from "A dashboard, as importable JSON" with the same name (import/dashboard.zip): ${dashboards.map((row) => row.name).join(', ')}.`] : []),
                  'A report section refers to its view or dashboard by id, and a report whose content is missing does not import.',
                ],
              },
              {
                heading: 'The report definition',
                files: ['import/report.zip'],
                how: ['Reports → Manage → ⋯ → Import, and choose import/report.zip — a zip holding content.xml, as a report export is.', 'If a view it names already exists and the dialog asks, choose to overwrite only if the view here is the newer one.'],
                verify: ['import/report.xml is the same content.xml as a bare file, for dialogs that take the XML on its own.', ...(dashboards.length > 0 ? ['a dashboard section is written as ContentType Dashboard with the dashboard id (sentania-labs reports_api_surface); open the report after import and check the dashboard page renders.'] : [])],
              },
              contentStep('REPORT_DEFINITIONS', 'import-report.sh'),
              {
                heading: 'Then the schedule',
                files: [`${base}-schedule.json`, 'schedule-report.sh'],
                how: ['./schedule-report.sh (add --dry-run first to preview) — POST /suite-api/api/reportdefinitions/{id}/schedules, with the report, the object or group and the email instance found by name. Or in the interface: the report’s Schedule action.'],
                verify: ['recurrence, daysOfTheWeek, dayOfTheMonth and emailPluginId against GET of a schedule made in the interface; read the schedule back in the interface after applying it.'],
              },
            ],
            sources: FORMAT_SOURCES,
          }),
        },
        notes: [
          CONTENT_IMPORT_NOTE,
          'Formats, the cover page, the table of contents, the footer and each section’s orientation are set on the report definition; the cadence, the object, the recipients and the email instance on the schedule.',
          'Publishing a generated report to a network share was removed in VCF Operations 9.1; reports go by email only, so no share path is written.',
          'VERIFY: GET /suite-api/api/reportdefinitions filtering by name, the reportDefinitions[] response key, and the emailPluginId field of a schedule, against your release; the script refuses rather than guesses if the lookups differ.',
        ],
        findings,
      };
    },
  }),
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_management_pack',
    platform: PLATFORM,
    label: 'Install or upgrade a management pack',
    group: 'Extend',
    description:
      'A management pack (.pak) checked before it goes anywhere near the cluster: its manifest read for its version and the minimum VCF Operations it needs, compared with what is running and with what is installed, and refused if it would be a downgrade. Then uploaded and installed through the cluster admin (CASA) API, with a change ticket required, and an account configured afterwards.',
    inputs: [
      { id: 'pak_file', label: '.pak file', control: 'text', default: 'vmware-mpforhcx-9.1.0.pak', hint: 'Beside the script, as downloaded from the Broadcom support portal or the Marketplace' },
      { id: 'solution_name', label: 'Solution name as listed', control: 'text', default: 'VMware HCX', hint: 'For display only: the installed pack is matched by the adapter kinds in the pak’s manifest' },
      {
        id: 'mode',
        label: 'This is',
        control: 'select',
        options: [
          { value: 'install', label: 'A new install' },
          { value: 'upgrade', label: 'An upgrade of an installed pack' },
        ],
        default: 'install',
      },
      { id: 'configure_account', label: 'Configure an account afterwards', control: 'toggle', default: true },
      { id: 'adapter_kind', label: 'Adapter kind', control: 'text', default: '<REQUIRED — adapter kind key from GET /suite-api/api/solutions/{id}/adapterkinds after install>', showWhen: { input: 'configure_account', equals: ['true'] } },
      { id: 'account_host', label: 'Account target host', control: 'text', default: 'hcx-mgr01.example.com', showWhen: { input: 'configure_account', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const pak = str(values, 'pak_file', 'management-pack.pak');
      const solution = str(values, 'solution_name', '');
      const mode = str(values, 'mode', 'install');
      const configure = bool(values, 'configure_account', true);
      const adapterKind = str(values, 'adapter_kind', '');
      const host = str(values, 'account_host', '');
      const base = slugOf(name || pak.replace(/\.pak$/i, ''), 'management-pack');

      const findings            = [];
      if (!/\.pak$/i.test(pak)) findings.push(error('vcfops.mp.not-pak', `${pak} does not end in .pak. Management packs are uploaded as .pak files.`, { source: SRC }));
      if (!solution) findings.push(info('vcfops.mp.no-solution', 'No solution name: the precheck matches the installed pack by the pak’s adapter kinds anyway; the name is only used to say when the listing calls it something else.', { source: SRC }));

      const precheck = readScript(PLATFORM, `Precheck ${pak} against the running VCF Operations. Changes nothing. Pass --upgrade when replacing an installed pack.`, [
        ...workDirLines(PLATFORM),
        `PAK='${sq(pak)}'`,
        'UPGRADE=0',
        '[[ "${1:-}" == "--upgrade" ]] && UPGRADE=1',
        '[[ -f "$PAK" ]] || { echo "$PAK is not here" >&2; exit 2; }',
        'command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 2; }',
        'PROBLEMS=0',
        '',
        '# A .pak is a zip with manifest.txt (JSON) at the top. VERIFY the field names',
        '# on your pak: `unzip -p file.pak manifest.txt | jq .`',
        'MANIFEST=$(unzip -p "$PAK" manifest.txt 2>/dev/null) || { echo "No manifest.txt in $PAK: is it really a management pack?" >&2; exit 2; }',
        'jq -e . >/dev/null <<<"$MANIFEST" || { echo "manifest.txt in $PAK is not JSON." >&2; exit 2; }',
        "PAK_VERSION=$(jq -r '.version // empty' <<<\"$MANIFEST\")",
        "PAK_MIN=$(jq -r '.vcops_minimum_version // .platform_minimum_version // empty' <<<\"$MANIFEST\")",
        "PAK_NAME=$(jq -r '.name // .display_name // empty' <<<\"$MANIFEST\")",
        '# The pack is identified by what it installs — its adapter kinds — not by a',
        '# display name, which differs between the manifest, the listing and releases.',
        "PAK_KINDS=$(jq -c '[(.adapter_kinds // .adapterKinds // [])[] | ascii_downcase] | unique' <<<\"$MANIFEST\")",
        'echo "pak:        ${PAK_NAME:-?} ${PAK_VERSION:-?}, adapter kinds ${PAK_KINDS}, needs VCF Operations ${PAK_MIN:-(not stated)}"',
        'if [[ "$PAK_KINDS" == "[]" ]]; then',
        '  echo "PROBLEM: the manifest names no adapter kinds, so the precheck cannot tell whether this pack is already installed. Read manifest.txt and check Integrations > Repository by hand." >&2',
        '  PROBLEMS=1',
        'fi',
        '',
        "OPS=$(get /suite-api/api/versions/current | jq -r '.releaseName // (\"\\(.major).\\(.minor).\\(.minorMinor // 0)\")')",
        'OPS_NUM=$(grep -oE "[0-9]+(\\.[0-9]+)+" <<<"$OPS" | head -1 || true)',
        'echo "running:    VCF Operations ${OPS} (${OPS_NUM:-?})"',
        '[[ -n "$OPS_NUM" ]] || { echo "PROBLEM: could not read the running version." >&2; PROBLEMS=1; }',
        'newer() { [[ "$(printf "%s\\n%s\\n" "$1" "$2" | sort -V | tail -1)" == "$1" && "$1" != "$2" ]]; }',
        'if [[ -n "$PAK_MIN" && -n "$OPS_NUM" ]] && newer "$PAK_MIN" "$OPS_NUM"; then',
        '  echo "PROBLEM: the pak needs ${PAK_MIN}, this is ${OPS_NUM}." >&2; PROBLEMS=1',
        'fi',
        '[[ -z "$PAK_MIN" ]] && echo "The manifest states no minimum version: check the pack’s release notes for 9.1 support."',
        '',
        '# Installed solutions sharing an adapter kind with the pak (case-insensitive),',
        '# from GET /solutions: solution[] {id, name, version, adapterKindKeys}.',
        'get /suite-api/api/solutions > "$WORK/solutions.json"',
        'jq -e \'has("solution")\' "$WORK/solutions.json" >/dev/null || { echo "GET /solutions returned no solution list." >&2; exit 2; }',
        "SAME=$(jq -c --argjson k \"$PAK_KINDS\" '[.solution[] | select([(.adapterKindKeys // [])[] | ascii_downcase] as $s | any($k[]; . as $x | $s | index($x)))] | map({id, name, version})' \"$WORK/solutions.json\")",
        "N_SAME=$(jq length <<<\"$SAME\")",
        "INSTALLED=$(jq -r 'map(.version // empty) | first // empty' <<<\"$SAME\")",
        'echo "installed:  $(jq -r \'if length == 0 then "none with these adapter kinds" else map("\\(.name) (\\(.id)) \\(.version)") | join(", ") end\' <<<"$SAME")"',
        ...(solution ? [`jq -e --arg n '${sq(solution)}' 'any(.[]; (.name // "") | ascii_downcase == ($n | ascii_downcase))' <<<"$SAME" >/dev/null || [[ "$N_SAME" == 0 ]] || echo "Note: installed as a different name than '${sq(solution)}'; matched on adapter kind."`] : []),
        '(( N_SAME <= 1 )) || { echo "PROBLEM: ${N_SAME} installed solutions share an adapter kind with this pak. Resolve that by hand first." >&2; PROBLEMS=1; }',
        'if (( N_SAME > 0 && ! UPGRADE )); then',
        '  echo "PROBLEM: a solution with the same adapter kind is installed (${INSTALLED:-version unknown}). Installing would replace it (CLOBBER). Re-run with --upgrade if that is the intent." >&2; PROBLEMS=1',
        'fi',
        'if (( N_SAME == 0 && UPGRADE )); then',
        '  echo "PROBLEM: --upgrade was given, and nothing with these adapter kinds is installed." >&2; PROBLEMS=1',
        'fi',
        ...(mode === 'upgrade' ? ['(( UPGRADE )) || echo "This was generated as an upgrade: pass --upgrade." >&2'] : []),
        'if [[ -n "$INSTALLED" && -n "$PAK_VERSION" ]] && newer "$INSTALLED" "$PAK_VERSION"; then',
        '  echo "PROBLEM: ${PAK_VERSION} is older than the installed ${INSTALLED}. Management packs do not downgrade." >&2; PROBLEMS=1',
        'fi',
        'if [[ -n "$INSTALLED" && "$INSTALLED" == "$PAK_VERSION" ]]; then',
        '  echo "PROBLEM: ${PAK_VERSION} is already installed." >&2; PROBLEMS=1',
        'fi',
        'exit $PROBLEMS',
      ]);

      const install = [
        '#!/usr/bin/env bash',
        `# Upload and install ${pak} through the cluster admin (CASA) API.`,
        '#',
        '#   install.sh --dry-run             precheck, then stop',
        '#   install.sh                       a new install: refused if a solution with the',
        '#                                    same adapter kind is already installed',
        '#   install.sh --upgrade             replace the installed pack (CLOBBER)',
        '#',
        '# Runs precheck.sh first and stops if it finds a problem. CHANGE_TICKET must be',
        '# set unless --dry-run is given.',
        '#',
        '# CASA is the appliance admin API, not the public suite API: it takes basic',
        '# auth as the local admin, and the paths below are the ones used since',
        '# the 8.x releases — VERIFY them on 9.1 before relying on this. The public suite API',
        '# lists installed solutions but has no install call.',
        'set -euo pipefail',
        '',
        'EXECUTE=1',
        'UPGRADE=0',
        'for arg in "$@"; do',
        '  case "$arg" in',
        '    --dry-run) EXECUTE=0 ;;',
        '    --upgrade) UPGRADE=1 ;;',
        '    *) echo "Unknown argument $arg. Use --dry-run to preview, and --upgrade to replace an installed pack." >&2; exit 2 ;;',
        '  esac',
        'done',
        ': "${VCFOPS_HOST:?set VCFOPS_HOST, e.g. vcfops.example.com}"',
        ': "${VCFOPS_ADMIN_USER:=admin}"',
        ': "${VCFOPS_ADMIN_PASSWORD_FILE:?set VCFOPS_ADMIN_PASSWORD_FILE to a file holding the admin password, mode 600}"',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        '',
        'if (( UPGRADE )); then',
        '  (cd "$HERE" && bash ./precheck.sh --upgrade) || { echo "Precheck failed; nothing was uploaded." >&2; exit 2; }',
        'else',
        '  (cd "$HERE" && bash ./precheck.sh) || { echo "Precheck failed; nothing was uploaded." >&2; exit 2; }',
        'fi',
        '',
        'if (( ! EXECUTE )); then',
        `  echo "DRY RUN: precheck passed. Would upload ${sq(pak)} and $( (( UPGRADE )) && echo "upgrade (CLOBBER)" || echo "install") it."`,
        '  exit 0',
        'fi',
        ': "${CHANGE_TICKET:?set CHANGE_TICKET: a management pack install restarts collection and cannot be downgraded}"',
        '',
        '# The admin credential goes to curl as a config file on stdin, never as an argument.',
        'casa() {',
        '  { printf \'user = "%s:\' "$VCFOPS_ADMIN_USER"; tr -d \'\\n\' < "$VCFOPS_ADMIN_PASSWORD_FILE" | sed \'s/[\\\\"]/\\\\&/g\'; printf \'"\\n\'; } |',
        '    curl -sS -f -K - "$@"',
        '}',
        '',
        '# CLOBBER replaces an installed pack and is sent only with --upgrade, after the',
        '# precheck has confirmed a solution with the same adapter kind is installed.',
        '# Without it no pak_handling_advice is sent — VERIFY the default on your release.',
        'ADVICE=""',
        '(( UPGRADE )) && ADVICE="?pak_handling_advice=CLOBBER"',
        `echo "[$CHANGE_TICKET] uploading ${sq(pak)}"`,
        `PAK_ID=$(casa -X POST "https://\${VCFOPS_HOST}/casa/upgrade/cluster/pak/reserved/operation/upload\${ADVICE}" \\`,
        `  -H "Accept: application/json" -F "contents=@$HERE/${sq(pak)}" | jq -r '.pak_id // empty')`,
        '[[ -n "$PAK_ID" ]] || { echo "Upload returned no pak_id." >&2; exit 2; }',
        'echo "pak_id ${PAK_ID}"',
        'echo "$PAK_ID" > "$HERE/pak-id.txt"',
        '',
        'casa -X POST "https://${VCFOPS_HOST}/casa/upgrade/cluster/pak/${PAK_ID}/operation/install" -H "Accept: application/json" -H "Content-Type: application/json" --data "{}" >/dev/null',
        'STATUS=""',
        'for _ in $(seq 1 90); do',
        '  STATUS=$(casa "https://${VCFOPS_HOST}/casa/upgrade/cluster/pak/${PAK_ID}/status" -H "Accept: application/json" | jq -r \'.cluster_pak_install_status // "?"\')',
        '  echo "$(date +%T) ${STATUS}"',
        '  case "$STATUS" in COMPLETED) break ;; FAILED|*ERROR*) echo "Install failed: read the Administration > Integrations > Repository page." >&2; exit 1 ;; esac',
        '  sleep 20',
        'done',
        '[[ "$STATUS" == COMPLETED ]] || { echo "Still ${STATUS} after 30 minutes; check the interface before running anything else." >&2; exit 1; }',
        `echo "[$CHANGE_TICKET] $( (( UPGRADE )) && echo upgrade || echo install ) complete."`,
        '',
      ].join('\n');

      const account = {
        name: `${host || 'target'}`,
        description: '',
        adapterKindKey: adapterKind,
        collectorId: '<REQUIRED — collector or collector group id: GET /suite-api/api/collectors>',
        resourceIdentifiers: [{ name: '<REQUIRED — the host identifier name from GET /suite-api/api/adapterkinds/{adapterKind}/resourcekinds>', value: host }],
        credential: { id: '<REQUIRED — id of a credential created under Integrations > Credentials, never written here>' },
      };

      return {
        platform: PLATFORM,
        title: `${mode === 'upgrade' ? 'Upgrade' : 'Install'} ${pak}`,
        effect: 'irreversible',
        trigger: { kind: 'manual', detail: 'Run by an administrator, under the change named in CHANGE_TICKET; never scheduled.', worstCase: 'once per change' },
        scope: {
          what: `The management pack in ${pak}, on every node of the VCF Operations cluster.`,
          decidedBy: ['The pak file itself.', 'The cluster: CASA distributes it to every node.', ...(configure ? [`The account for ${host}, created afterwards.`] : [])],
          ifWrong: 'A pack that does not support this release can stop its adapter collecting, or break content other packs depend on. There is no downgrade: the way back is uninstalling it (losing its history) or restoring the cluster from backup.',
        },
        guardrails: [
          { rule: 'precheck.sh runs first and install.sh stops if it exits non-zero', because: 'Installing a pack built for an older platform is the usual cause of an adapter that stops collecting after an upgrade.' },
          { rule: 'The installed pack is found by the pak’s own adapter kinds (manifest.txt adapter_kinds, matched case-insensitively against adapterKindKeys in GET /solutions), not by display name; a manifest with no adapter kinds is a precheck failure', because: 'A display name that differs by one word ("VMware HCX" vs "HCX") made an installed pack look absent, and the upload then replaced it.' },
          { rule: 'Refuses to install over a solution with the same adapter kind unless --upgrade is given, refuses --upgrade when none is installed, refuses a downgrade or the same version, and sends CLOBBER only with --upgrade', because: 'CLOBBER replaces what is installed; a wrong file quietly rolls a pack back.' },
          { rule: 'Requires CHANGE_TICKET (only --dry-run runs without it)', because: 'The install restarts collection across the cluster and cannot be undone by re-running anything; it belongs in a change window with a person who approved it.' },
          { rule: 'Admin password read from a mode-600 file and passed on stdin', because: 'CASA takes the local admin credential; on a command line it would be in the process list of the jump host.' },
        ],
        dryRun: [`Run precheck.sh${mode === 'upgrade' ? ' --upgrade' : ''} on its own: it only reads the pak and two GETs.`, `Run install.sh --dry-run${mode === 'upgrade' ? ' --upgrade' : ''}: it runs the precheck and stops.`],
        undo: [
          'There is no downgrade. To go back: uninstall the pack under Administration > Integrations > Repository (its objects and history go with it), then install the previous .pak.',
          'Take a VCF Operations cluster backup (or snapshot, per your backup design) before an upgrade: that is the only full way back.',
        ],
        told: ['The change ticket in CHANGE_TICKET, which every line install.sh prints carries.', 'Administration > Audit in VCF Operations records the install.'],
        requires: [
          'The .pak beside the scripts, downloaded from the vendor with its checksum verified.',
          'The local admin account of the VCF Operations cluster, in VCFOPS_ADMIN_PASSWORD_FILE.',
          'A suite API account for the precheck (VCFOPS_TOKEN or VCFOPS_USER/VCFOPS_PASSWORD_FILE).',
          'jq, unzip, sort -V (GNU coreutils) and curl.',
        ],
        files: {
          'precheck.sh': precheck,
          'install.sh': install,
          ...(configure ? { [`${base}-account.json`]: `${JSON.stringify(account, null, 2)}\n` } : {}),
          'IMPORT.md': importMd({
            title: `the management pack ${pak}`,
            steps: [
              { heading: 'Check it', files: ['precheck.sh'], how: [`Put ${pak} beside the scripts and run ./precheck.sh. The .pak itself is the vendor's file, imported as it is; nothing here rewrites it.`] },
              {
                heading: 'Install it',
                files: [pak, 'install.sh'],
                how: [`In the interface: Administration → Integrations → Repository → Add (8.x: Data Sources → Integrations → Repository → Add), and choose ${pak}.`, 'By API: CHANGE_TICKET=… ./install.sh (add --dry-run first to preview), which uploads and installs it through the cluster admin API.'],
                verify: ['the cluster admin (CASA) upload and install calls — see the notes in README.md.'],
              },
              ...(configure ? [{ heading: 'Then its account', files: [`${base}-account.json`], how: ['POST /suite-api/api/adapters with this file (or "Add an adapter instance" in this kit, which also handles the credential and certificate), or Administration → Integrations → Accounts → Add Account.'] }] : []),
            ],
          }),
        },
        notes: [
          'CONFIRMED: GET /suite-api/api/solutions and /solutions/{id}/adapterkinds are in the 9.1 API reference; they list, they do not install. VERIFY: the CASA upload/install/status paths and the pak_id and cluster_pak_install_status fields come from 8.x usage and are not in the public reference.',
          'CONFIRMED: GET /solutions returns solution[] with id, name, version and adapterKindKeys. VERIFY: the manifest.txt field names (version, vcops_minimum_version, adapter_kinds) on your pak, and releaseName in GET /versions/current; the precheck prints what it found, and a manifest with no adapter kinds fails it.',
          `Run it as install.sh${mode === 'upgrade' ? ' --upgrade' : ''} with CHANGE_TICKET set; add --dry-run to run only the precheck.`,
          'In VCF 9.x the supported route is also the interface: Administration > Integrations > Repository > Add. If the CASA calls are refused, use that and keep precheck.sh as the gate.',
          ...(configure ? ['Configure the account with POST /suite-api/api/adapters using the JSON beside this, or with "Add an adapter instance" in this kit, which handles the credential and certificate trust steps.'] : []),
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_mp_builder',
    platform: PLATFORM,
    label: 'Design a Management Pack Builder pack (REST or Prometheus)',
    group: 'Extend',
    description:
      'The design a Management Pack Builder project needs before anyone opens the builder: the source (a REST API, or in 9.1 a Prometheus server), the object types, which response field or PromQL query becomes which metric, the relationships and the collection interval — plus a read-only test script that calls the source the way the pack will.',
    inputs: [
      {
        id: 'source',
        label: 'Source',
        control: 'select',
        options: [
          { value: 'rest', label: 'REST API' },
          { value: 'prometheus', label: 'Prometheus server (9.1)' },
        ],
        default: 'prometheus',
      },
      { id: 'base_url', label: 'Base URL', control: 'text', default: 'https://prometheus.example.com:9090' },
      {
        id: 'auth',
        label: 'Authentication',
        control: 'select',
        options: [
          { value: 'none', label: 'None' },
          { value: 'basic', label: 'Basic' },
          { value: 'bearer', label: 'Bearer token' },
        ],
        default: 'bearer',
      },
      { id: 'object_type', label: 'Object type', control: 'text', default: 'Kafka Broker' },
      { id: 'identifier', label: 'Identified by', control: 'text', default: 'instance', hint: 'A Prometheus label, or a field in each REST item' },
      { id: 'list_path', label: 'List request path', control: 'text', default: '/api/v1/brokers', showWhen: { input: 'source', equals: ['rest'] } },
      { id: 'items_path', label: 'Items in the response at', control: 'text', default: '.items', showWhen: { input: 'source', equals: ['rest'] } },
      {
        id: 'metrics',
        label: 'Metrics',
        control: 'textarea',
        default: 'Bytes in per sec = sum by (instance) (rate(kafka_server_brokertopicmetrics_bytesin_total[5m]))\nUnder-replicated partitions = sum by (instance) (kafka_server_replicamanager_underreplicatedpartitions)',
        hint: 'One per line: name = PromQL (Prometheus) or name = field path (REST)',
      },
      { id: 'relationships', label: 'Relationships', control: 'textarea', default: 'Kafka Broker -> VirtualMachine by name', hint: 'One per line: child -> parent by matching property' },
      { id: 'interval', label: 'Collection interval (minutes)', control: 'number', default: 5, min: 1, max: 1440 },
    ],
    automation: (values                 , name        )             => {
      const source = str(values, 'source', 'prometheus');
      const baseUrl = str(values, 'base_url', '').replace(/\/+$/, '');
      const auth = str(values, 'auth', 'none');
      const objectType = str(values, 'object_type', 'Object');
      const identifier = str(values, 'identifier', 'instance');
      const listPath = str(values, 'list_path', '/');
      const itemsPath = str(values, 'items_path', '.');
      const interval = num(values, 'interval', 5);
      const base = slugOf(name || objectType, 'mp-design');
      const metrics = str(values, 'metrics', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('=');
          return at < 0 ? { name: line, expr: '' } : { name: line.slice(0, at).trim(), expr: line.slice(at + 1).trim() };
        });
      const relationships = str(values, 'relationships', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const m = /^(.+?)\s*->\s*(.+?)(?:\s+by\s+(.+))?$/.exec(line);
          return m ? { child: m[1] .trim(), parent: m[2] .trim(), match: (m[3] ?? '').trim() } : { child: line, parent: '', match: '' };
        });

      const findings            = [];
      if (metrics.length === 0) findings.push(error('vcfops.mpb.no-metrics', 'An object type with no metrics is an inventory entry and nothing else.', { source: SRC }));
      const noExpr = metrics.filter((metric) => !metric.expr);
      if (noExpr.length > 0) findings.push(error('vcfops.mpb.empty-metric', `No ${source === 'prometheus' ? 'query' : 'field'} for ${noExpr.map((m) => m.name).join(', ')}.`, { source: SRC }));
      if (!/^https?:\/\//.test(baseUrl)) findings.push(error('vcfops.mpb.url', `${baseUrl || 'The base URL'} is not an http(s) URL.`, { source: SRC }));
      if (baseUrl.startsWith('http://') && auth !== 'none') {
        findings.push(warning('vcfops.mpb.cleartext', 'Credentials over plain http.', { remediation: 'The pack sends them every collection cycle. Put the source behind TLS first.', source: SRC }));
      }
      if (interval < 5) findings.push(warning('vcfops.mpb.interval', `A ${interval}-minute interval is shorter than VCF Operations' own five-minute cycle.`, { remediation: 'Collections faster than the cycle are not stored any finer; they only load the source.', source: SRC }));
      if (source === 'prometheus') {
        const unaggregated = metrics.filter((metric) => metric.expr && !metric.expr.includes(identifier));
        if (unaggregated.length > 0) {
          findings.push(
            warning('vcfops.mpb.label', `${unaggregated.map((m) => m.name).join(', ')} do${unaggregated.length === 1 ? 'es' : ''} not mention the identifying label "${identifier}".`, {
              remediation: `Aggregate with "by (${identifier})" so each series maps to exactly one ${objectType}; otherwise one object receives many series, or none.`,
              source: SRC,
            }),
          );
        }
      }
      const orphans = relationships.filter((rel) => !rel.parent || !rel.match);
      if (orphans.length > 0) findings.push(warning('vcfops.mpb.relationship', `Relationship "${orphans.map((r) => r.child).join(', ')}" needs "child -> parent by property".`, { source: SRC }));

      const design = {
        note: 'A design worksheet for Management Pack Builder, not the builder’s own export format.',
        source: {
          type: source === 'prometheus' ? 'Prometheus' : 'REST',
          baseUrl,
          authentication: auth,
          credentialFrom: auth === 'none' ? null : 'Entered in the builder’s source settings; never stored in this file.',
        },
        objectTypes: [
          {
            name: objectType,
            identifier,
            ...(source === 'rest' ? { request: { method: 'GET', path: listPath, itemsAt: itemsPath } } : {}),
            metrics: metrics.map((metric) => (source === 'prometheus' ? { name: metric.name, promql: metric.expr } : { name: metric.name, field: metric.expr })),
          },
        ],
        relationships,
        collectionIntervalMinutes: interval,
      };

      const md = [
        `# ${objectType} — Management Pack Builder design`,
        '',
        `Source: ${source === 'prometheus' ? 'Prometheus server' : 'REST API'} at ${baseUrl}, auth ${auth}. Collected every ${interval} minutes.`,
        '',
        `## Object type: ${objectType}`,
        '',
        `Identified by \`${identifier}\`.${source === 'rest' ? ` Listed by GET \`${listPath}\`, items at \`${itemsPath}\`.` : ' One object per distinct value of that label across the queries below.'}`,
        '',
        '| Metric | ' + (source === 'prometheus' ? 'PromQL' : 'Field') + ' |',
        '|---|---|',
        ...metrics.map((metric) => `| ${metric.name} | \`${metric.expr.replace(/\|/g, '\\|')}\` |`),
        '',
        '## Relationships',
        '',
        ...(relationships.length > 0 ? relationships.map((rel) => `- ${rel.child} is a child of ${rel.parent || '?'}, matched on ${rel.match || '?'}`) : ['None.']),
        '',
        '## Building it',
        '',
        '1. Run test-source.sh and keep its output: those are the responses you will map.',
        '2. In VCF Operations, open Management Pack Builder and create a design with this source.',
        '3. Add the object type, the requests or queries, and the metrics above; set the identifier.',
        '4. Add the relationships, set the interval, run the builder’s own test, then build and install the .pak.',
        '',
      ].join('\n');

      const header = auth === 'bearer'
        ? ['  # The token goes to curl as a header on stdin, never as an argument.', '  printf "Authorization: Bearer %s\\n" "$(tr -d \'\\n\' < "$SOURCE_SECRET_FILE")" | curl -sS -f -H @- "$@"']
        : auth === 'basic'
          ? ['  # user:password goes to curl as a config file on stdin, never as an argument.', '  { printf \'user = "%s:\' "$SOURCE_USER"; tr -d \'\\n\' < "$SOURCE_SECRET_FILE"; printf \'"\\n\'; } | curl -sS -f -K - "$@"']
          : ['  curl -sS -f "$@"'];

      const test = [
        '#!/usr/bin/env bash',
        `# Call ${baseUrl} the way the pack will, and show what comes back. Reads only.`,
        '# Exits 1 if any request returns nothing to map.',
        'set -euo pipefail',
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        ...(auth !== 'none' ? [': "${SOURCE_SECRET_FILE:?set SOURCE_SECRET_FILE to a file holding the source credential, mode 600}"'] : []),
        ...(auth === 'basic' ? [': "${SOURCE_USER:?set SOURCE_USER}"'] : []),
        `BASE='${sq(baseUrl)}'`,
        'PROBLEMS=0',
        'call() {',
        ...header,
        '}',
        '',
        ...(source === 'prometheus'
          ? metrics.flatMap((metric) => [
              `echo "== ${metric.name.replace(/["$`\\]/g, '')}"`,
              `OUT=$(call -G "$BASE/api/v1/query" --data-urlencode 'query=${sq(metric.expr)}')`,
              `N=$(jq '.data.result | length' <<<"$OUT")`,
              `jq -r '.data.result[:5][] | "\\(.metric.${identifier.replace(/[^A-Za-z0-9_]/g, '_')} // "(no ${identifier.replace(/[^A-Za-z0-9_]/g, '_')} label)")  \\(.value[1])"' <<<"$OUT"`,
              'echo "${N} series"; (( N > 0 )) || PROBLEMS=1',
            ])
          : [
              `OUT=$(call "$BASE${listPath}")`,
              `N=$(jq '${itemsPath} | length' <<<"$OUT")`,
              `echo "${objectType.replace(/["$`\\]/g, '')}: \${N} item(s) at ${itemsPath}"`,
              `jq '${itemsPath}[0]' <<<"$OUT"`,
              '(( N > 0 )) || PROBLEMS=1',
              ...metrics.map((metric) => `jq -r '${itemsPath}[0] | ${metric.expr.startsWith('.') ? metric.expr : `.${metric.expr}`} // "MISSING"' <<<"$OUT" | sed 's/^/${metric.name.replace(/[/'&\\]/g, '')}: /'`),
            ]),
        'exit $PROBLEMS',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Management Pack Builder design — ${objectType} from ${source === 'prometheus' ? 'Prometheus' : 'REST'}`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Once built, the pack collects every ${interval} minutes; this design and test script only read.`, worstCase: `one request per query every ${interval} minutes, against the source` },
        scope: {
          what: `The source at ${baseUrl}, read-only; and, once built, objects of type ${objectType}.`,
          decidedBy: [source === 'prometheus' ? `Distinct values of the "${identifier}" label in the query results.` : `Items at ${itemsPath} in GET ${listPath}.`, 'Relationships, which place the new objects under existing ones.'],
          ifWrong: 'Objects that multiply every collection (an identifier that is not stable), or metrics attached to the wrong object. Both are cleaned up by deleting the objects, but their history is lost.',
        },
        guardrails: [
          { rule: 'The test script only sends GETs', because: 'Testing a source must not change it; a builder test against a write endpoint has changed production before.' },
          { rule: 'The credential is read from a mode-600 file and sent on stdin', because: 'A source token on a command line is in the shell history of whoever tested the pack.' },
        ],
        dryRun: ['Run test-source.sh: every query or request the pack will make, once, with the results printed.'],
        undo: ['Nothing to undo for the design. Once built and installed, uninstall the pack under Integrations > Repository.'],
        told: ['Nobody; it is a design.'],
        requires: ['Network reach from the VCF Operations collector to the source, not only from your desktop.', 'jq and curl for the test script.', 'VCF Operations 9.1 or later for a Prometheus source.'],
        files: {
          [`${base}-design.json`]: `${JSON.stringify(design, null, 2)}\n`,
          [`${base}-design.md`]: md,
          'test-source.sh': test,
          'IMPORT.md': nothingToImportMd('a Management Pack Builder design', [
            'Management Pack Builder has no documented design-import format, so this design is a worksheet, not a file to import: build the project in Administration → Management Pack Builder from the design .md, source by source and object by object.',
            'Run ./test-source.sh first: it calls the source the way the pack will, so a wrong URL or query shows here rather than in the builder.',
            `When the project builds, export the .pak from the builder and install it like any other management pack (Administration → Integrations → Repository → Add).`,
          ]),
        },
        notes: [
          'Prometheus as a builder source is new in 9.1 (VCF Operations 9.1 release notes). The builder’s own design export format is not documented, so this design is a worksheet to build from, not a file to import.',
          'Use a stable identifier. A Prometheus instance label that includes a pod IP makes a new object every time the pod restarts.',
          'The Prometheus test uses GET /api/v1/query, the standard Prometheus HTTP API.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_orchestrator',
    platform: PLATFORM,
    label: 'An orchestrator workflow in Python or PowerShell',
    group: 'Extend',
    description:
      'A scriptable workflow for the VCF Operations orchestrator in 9.1: the repository layout (with the dev and prod package repositories 9.1 lets a scripting environment use), a Python or PowerShell handler that defaults to a dry run, the error-handling pattern for the enhanced default error handler, and a script that starts the workflow over the orchestrator REST API.',
    inputs: [
      { id: 'workflow_name', label: 'Workflow name', control: 'text', default: 'Tag untagged VMs' },
      {
        id: 'language',
        label: 'Language',
        control: 'select',
        options: [
          { value: 'python', label: 'Python' },
          { value: 'powershell', label: 'PowerShell' },
        ],
        default: 'python',
      },
      { id: 'dev_repo', label: 'Development package repository', control: 'text', default: 'https://artifactory.example.com/api/pypi/pypi-dev/simple' },
      { id: 'prod_repo', label: 'Production package repository', control: 'text', default: 'https://artifactory.example.com/api/pypi/pypi-prod/simple' },
      { id: 'git_repo', label: 'Source repository', control: 'text', default: 'https://git.example.com/platform/vcf-orchestrator.git' },
      { id: 'session_timeout', label: 'UI session timeout (minutes)', control: 'number', default: 30, min: 5, max: 1440 },
      { id: 'reentry_limit', label: 'Error-handler re-entry limit', control: 'number', default: 1, min: 0, max: 10 },
    ],
    automation: (values                 , name        )             => {
      const wfName = str(values, 'workflow_name', 'Workflow');
      const language = str(values, 'language', 'python');
      const devRepo = str(values, 'dev_repo', '');
      const prodRepo = str(values, 'prod_repo', '');
      const gitRepo = str(values, 'git_repo', '');
      const timeout = num(values, 'session_timeout', 30);
      const reentry = num(values, 'reentry_limit', 1);
      const slug = slugOf(name || wfName, 'workflow');
      const py = language === 'python';

      const findings            = [];
      if (devRepo && devRepo === prodRepo) findings.push(warning('vcfops.orch.same-repo', 'Development and production use the same package repository.', { remediation: 'The point of two repositories in 9.1 is that a dependency is promoted, not picked up. Use two.', source: SRC }));
      if (timeout > 480) findings.push(warning('vcfops.orch.timeout', `A ${timeout}-minute session timeout keeps an unattended administrator session open all day.`, { source: SRC }));
      if (reentry > 3) findings.push(warning('vcfops.orch.reentry', `A re-entry limit of ${reentry} lets a failing error handler loop.`, { remediation: 'One is enough to report the error that happened inside the handler.', source: SRC }));

      const handler = py
        ? [
            '"""',
            `${wfName} — scriptable task for the VCF Operations orchestrator.`,
            '',
            ' Defaults to a dry run: nothing changes unless the',
            'workflow input dryRun is false. Credentials come from the orchestrator',
            '(configuration elements or secure-string inputs), never from this file.',
            '"""',
            '',
            '',
            'def handler(context, inputs):',
            '    dry_run = inputs.get("dryRun", True)',
            '    targets = inputs.get("targets", [])',
            '    limit = int(inputs.get("maxTargets", 25))',
            '    if len(targets) > limit:',
            '        # Raising here sends the run to the workflow\'s error handler.',
            '        raise ValueError(f"{len(targets)} targets exceeds maxTargets={limit}; refusing to run")',
            '    changed = []',
            '    for target in targets:',
            '        if dry_run:',
            '            print(f"DRY RUN: would act on {target}")',
            '            continue',
            '        # TODO: the real change, one target at a time.',
            '        changed.append(target)',
            '    return {"dryRun": dry_run, "changed": changed, "count": len(changed)}',
            '',
          ].join('\n')
        : [
            '<#',
            `    ${wfName} — scriptable task for the VCF Operations orchestrator.`,
            '    Defaults to a dry run: nothing changes unless',
            '    the workflow input dryRun is false. Credentials come from the',
            '    orchestrator (configuration elements or secure-string inputs).',
            '#>',
            'function Handler($context, $inputs) {',
            '    $dryRun = if ($null -eq $inputs.dryRun) { $true } else { [bool]$inputs.dryRun }',
            '    $targets = @($inputs.targets)',
            '    $limit = if ($inputs.maxTargets) { [int]$inputs.maxTargets } else { 25 }',
            '    if ($targets.Count -gt $limit) {',
            '        # Throwing sends the run to the workflow\'s error handler.',
            '        throw "$($targets.Count) targets exceeds maxTargets=$limit; refusing to run"',
            '    }',
            '    $changed = @()',
            '    foreach ($target in $targets) {',
            '        if ($dryRun) { Write-Host "DRY RUN: would act on $target"; continue }',
            '        # TODO: the real change, one target at a time.',
            '        $changed += $target',
            '    }',
            '    return @{ dryRun = $dryRun; changed = $changed; count = $changed.Count }',
            '}',
            '',
          ].join('\n');

      const workflowSpec = {
        name: wfName,
        inputs: [
          { name: 'dryRun', type: 'boolean', default: true },
          { name: 'targets', type: 'Array/string' },
          { name: 'maxTargets', type: 'number', default: 25 },
        ],
        outputs: [{ name: 'result', type: 'Properties' }],
        items: [
          { type: 'scriptable-task', name: 'Act', runtime: py ? '<VERIFY — the Python runtime your 9.1 build offers, e.g. python:3.11>' : '<VERIFY — the PowerShell runtime your 9.1 build offers, e.g. powercli:13-powershell-7.4>', entryPoint: py ? 'handler.handler' : 'handler.ps1:Handler', environment: `${slug}-env` },
          { type: 'default-error-handler', name: 'On error', reentryLimit: reentry, action: 'Log the error and the item it came from, set result.failed = true, end the workflow in error.' },
        ],
        environment: {
          name: `${slug}-env`,
          language: py ? 'python' : 'powershell',
          repositories: [
            { name: 'dev', url: devRepo },
            { name: 'prod', url: prodRepo },
          ],
          dependencies: py ? ['requests'] : ['VMware.PowerCLI'],
        },
        uiSessionTimeoutMinutes: timeout,
      };

      const run = [
        '#!/usr/bin/env bash',
        `# Start "${wfName}" over the orchestrator REST API and wait for it.`,
        '#',
        '# Sends dryRun=false: the workflow acts when this is run. With --dry-run it',
        '# sends dryRun=true and the workflow only reports. The token comes from',
        '# ORCH_TOKEN, or from ORCH_TOKEN_FILE (mode 600).',
        'set -euo pipefail',
        ': "${ORCH_HOST:?set ORCH_HOST, e.g. vcfops-orch.example.com}"',
        ': "${WORKFLOW_ID:?set WORKFLOW_ID: GET /vco/api/workflows?conditions=name=... after importing}"',
        'if [[ -z "${ORCH_TOKEN:-}" && -n "${ORCH_TOKEN_FILE:-}" ]]; then ORCH_TOKEN=$(tr -d "\\n" < "$ORCH_TOKEN_FILE"); fi',
        ': "${ORCH_TOKEN:?set ORCH_TOKEN or ORCH_TOKEN_FILE — how it is obtained depends on the orchestrator authentication mode; VERIFY for 9.1}"',
        ...privateHeader('ORCH_AUTH', 'Authorization: Bearer', 'ORCH_TOKEN'),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        'DRY=false; [[ " $* " == *" --dry-run "* ]] && DRY=true',
        'TARGETS=${TARGETS:-}',
        '',
        '# The execution body is the standard orchestrator parameter list.',
        'BODY=$(jq -n --argjson dry "$DRY" --arg t "$TARGETS" \'{parameters: [',
        '  {name: "dryRun", type: "boolean", value: {boolean: {value: $dry}}},',
        '  {name: "targets", type: "Array/string", value: {array: {elements: [$t | split(",")[] | select(length > 0) | {string: {value: .}}]}}}',
        ']}\')',
        'echo "dryRun=${DRY}"',
        'orch() { curl -sS -f -H "@${ORCH_AUTH}" -H "Accept: application/json" -H "Content-Type: application/json" "$@"; }',
        'LOCATION=$(echo "$BODY" | orch -X POST "https://${ORCH_HOST}/vco/api/workflows/${WORKFLOW_ID}/executions" --data @- -D - -o /dev/null | tr -d "\\r" | awk -F": " \'tolower($1)=="location"{print $2}\')',
        '[[ -n "$LOCATION" ]] || { echo "The orchestrator started no execution (no Location header)." >&2; exit 1; }',
        'echo "execution ${LOCATION}"',
        'for _ in $(seq 1 60); do',
        '  STATE=$(orch "${LOCATION%/}/state" | jq -r .value)',
        '  echo "$(date +%T) ${STATE}"',
        '  case "$STATE" in completed) exit 0 ;; failed|canceled) exit 1 ;; esac',
        '  sleep 5',
        'done',
        'exit 1',
        '',
      ].join('\n');

      const layout = [
        `${slug}/`,
        '  README-workflow.txt      what the workflow does, its inputs, and who owns it',
        '  workflow.json            the workflow design (inputs, items, error handler, environment)',
        `  actions/${slug}/${py ? 'handler.py' : 'handler.ps1'}`,
        `  environment/${py ? 'requirements.txt' : 'modules.psd1'}  pinned dependencies, resolved from the dev or prod repository`,
        '  run-workflow.sh          start it over REST (it acts; --dry-run previews)',
        '',
        `Source: ${gitRepo || '(set a repository)'}. Branches: main is what runs in production; changes arrive by merge request.`,
        '',
        'Setup in the orchestrator 9.1 client:',
        `  1. Assets > Environments: create ${slug}-env (${py ? 'Python' : 'PowerShell'}), and add the two repositories —`,
        `     dev: ${devRepo || '(unset)'}`,
        `     prod: ${prodRepo || '(unset)'}`,
        '     9.1 allows up to two repositories per scripting environment. Point production at the prod one only.',
        '  2. Create the workflow with the scriptable task above, bound to that environment.',
        `  3. Add a Default error handler item. In 9.1 it can catch errors raised inside itself; set its re-entry limit to ${reentry}.`,
        `  4. Administration: set the UI session timeout to ${timeout} minutes (new in 9.1). VERIFY the exact setting location in your build.`,
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `Orchestrator workflow "${wfName}" (${py ? 'Python' : 'PowerShell'})`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: 'Started by run-workflow.sh, a person in the client, or a VCF Operations action that calls it.', worstCase: 'once per call; an alert-driven caller can call it once per alert' },
        scope: {
          what: 'The targets passed in the targets input, at most maxTargets of them per run.',
          decidedBy: ['Whoever calls it decides the targets list.', 'maxTargets (default 25) caps it.', 'The orchestrator account’s own permissions on the systems the handler touches.'],
          ifWrong: 'The handler acts on every target it is given, up to the cap. The cap is what keeps a wrong list at 25 objects instead of the estate.',
        },
        guardrails: [
          { rule: 'dryRun defaults to true in the workflow and in the handler', because: 'A workflow started from the client with default inputs must not change anything.' },
          { rule: 'The handler refuses more than maxTargets targets', because: 'A caller passing a whole custom group by mistake is stopped before the first change.' },
          { rule: 'run-workflow.sh always sends dryRun explicitly: false when run, true with --dry-run', because: 'The run from a terminal does what it says, whatever the workflow input defaults to.' },
          { rule: 'run-workflow.sh gives the token to curl from a private header file (mode 600, removed on exit), never as an argument', because: 'A token on a command line is readable by every user of the jump host through ps.' },
          { rule: `The default error handler has a re-entry limit of ${reentry}`, because: '9.1 lets the handler catch its own errors; without a limit a failing handler loops.' },
        ],
        dryRun: ['Run run-workflow.sh --dry-run: the workflow runs with dryRun=true and prints what it would act on.'],
        undo: ['The workflow itself is deleted in the client. What the handler changed is reversed by whatever the TODO does — write the reverse into the handler before taking the TODO out.'],
        told: ['The workflow run log in the orchestrator, with every DRY RUN line.', 'The caller, through the result output.'],
        requires: [
          'VCF Operations orchestrator 9.1 for the two-repository environments, the self-catching error handler and the session timeout setting.',
          'The two package repositories reachable from the orchestrator appliance.',
          'jq and curl for run-workflow.sh.',
        ],
        files: {
          'layout.txt': layout,
          'workflow.json': `${JSON.stringify(workflowSpec, null, 2)}\n`,
          [`actions/${slug}/${py ? 'handler.py' : 'handler.ps1'}`]: handler,
          [`import/${slug}-action.zip/${py ? 'handler.py' : 'handler.ps1'}`]: handler,
          [py ? 'environment/requirements.txt' : 'environment/modules.psd1']: py ? 'requests==2.32.3\n' : "@{ RequiredModules = @(@{ ModuleName = 'VMware.PowerCLI'; RequiredVersion = '<VERIFY — the PowerCLI version your runtime supports>' }) }\n",
          'run-workflow.sh': run,
          'IMPORT.md': importMd({
            title: `the orchestrator workflow "${wfName}"`,
            steps: [
              {
                heading: 'The scripting environment',
                files: [py ? 'environment/requirements.txt' : 'environment/modules.psd1'],
                how: [`Orchestrator → Assets → Environments → New: runtime ${py ? 'Python' : 'PowerShell'}, the dependencies from this file, and the package repositories in layout.txt.`],
              },
              {
                heading: 'The action',
                files: [`import/${slug}-action.zip`],
                how: [`Orchestrator → Library → Actions → New: runtime ${py ? 'Python' : 'PowerShell'} with the environment above, script type "Import package", and choose import/${slug}-action.zip — the handler at the root of the zip, entry handler ${py ? 'handler.handler' : 'handler.Handler'}.`],
                verify: ['the orchestrator in VCF Operations 9.1 is documented only in the release notes; the zip-package route is the long-standing Orchestrator one for Python and PowerShell actions.'],
              },
              {
                heading: 'The workflow',
                files: ['workflow.json'],
                how: ['workflow.json is a design record, not the orchestrator\'s package format (a .workflow file is a signed-or-UTF-16 zip this toolkit does not write). Create the workflow in the workflow editor with one scriptable task that calls the action, with the inputs listed there.', 'Then ./run-workflow.sh starts it over the REST API (POST /vco/api/workflows/{id}/executions).'],
              },
            ],
          }),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: up to two repositories for Python and PowerShell scripting environments, a default error handler that can catch errors raised inside itself with a configurable re-entry limit, and a configurable UI session timeout.',
          'VERIFY: whether "repositories" in your build means package sources (as written here) or Git sources; the runtime names; and how ORCH_TOKEN is issued in your authentication mode. workflow.json is a design record, not the orchestrator’s package format — create the workflow in the client or import it as a package you exported.',
          'POST /vco/api/workflows/{id}/executions with a parameters list, the Location header and GET …/executions/{id}/state are the long-standing orchestrator REST calls.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_integrations_hcx',
    platform: PLATFORM,
    label: 'VCF Operations HCX: migration readiness report',
    group: 'Extend',
    description:
      'A read-only readiness report before a migration wave: is the 9.1 HCX management pack installed in VCF Operations, is HCX Manager answering, what version it is, how long its certificate has left, and whether the service meshes are up. It exits non-zero on anything that should stop a wave.',
    inputs: [
      { id: 'hcx_host', label: 'HCX Manager', control: 'text', default: 'hcx-mgr01.example.com' },
      { id: 'hcx_user', label: 'HCX user', control: 'text', default: 'svc-hcx-readonly@vsphere.local' },
      { id: 'cert_days', label: 'Warn when the certificate expires within (days)', control: 'number', default: 30, min: 1, max: 365 },
      { id: 'check_mp', label: 'Check the HCX management pack in VCF Operations', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const hcx = str(values, 'hcx_host', 'hcx.example.com');
      const user = str(values, 'hcx_user', '');
      const days = num(values, 'cert_days', 30);
      const checkMp = bool(values, 'check_mp', true);
      const base = slugOf(name || 'hcx-readiness', 'hcx-readiness');

      const findings            = [];
      if (/^admin(istrator)?(@|$)/i.test(user)) {
        findings.push(warning('vcfops.hcx.admin', `${user} is an administrator account for a read-only report.`, { remediation: 'Use an account with a read-only role in HCX; a report does not need to be able to start a migration.', source: SRC }));
      }

      const script = readScript(PLATFORM, `HCX migration readiness for ${hcx}. Reads only; exits 1 when something should stop a wave.`, [
        `HCX='${sq(hcx)}'`,
        `: "\${HCX_USER:=${sq(user)}}"`,
        ': "${HCX_PASSWORD_FILE:?set HCX_PASSWORD_FILE to a file holding the HCX user password, mode 600}"',
        'PROBLEMS=0',
        'problem() { echo "PROBLEM: $*"; PROBLEMS=1; }',
        '',
        ...(checkMp
          ? [
              '# 1. The HCX management pack in VCF Operations (new in 9.1: password and',
              '#    certificate rotation, log bundles).',
              "MP=$(get /suite-api/api/solutions | jq -r '[.solution[]? | select(.name | test(\"HCX\"; \"i\")) | \"\\(.name) \\(.version)\"] | first // empty')",
              '[[ -n "$MP" ]] && echo "management pack: $MP" || problem "no HCX management pack is installed in VCF Operations"',
              '',
            ]
          : []),
        '# 2. The certificate HCX Manager presents.',
        'END=$(echo | openssl s_client -connect "${HCX}:443" -servername "$HCX" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2) || true',
        'if [[ -z "$END" ]]; then',
        '  problem "could not read a certificate from ${HCX}:443"',
        'else',
        '  LEFT=$(( ( $(date -d "$END" +%s) - $(date +%s) ) / 86400 ))',
        '  echo "certificate: ${LEFT} days left (${END})"',
        `  (( LEFT >= ${days} )) || problem "certificate expires in \${LEFT} days"`,
        'fi',
        '',
        '# 3. Log in to HCX. The password is sent on stdin; the session token comes back',
        '#    in the x-hm-authorization header.',
        'SESSION=$(jq -n --arg u "$HCX_USER" --rawfile p "$HCX_PASSWORD_FILE" \'{username: $u, password: ($p | rtrimstr("\\n"))}\' |',
        '  curl -sS -f -X POST "https://${HCX}/hybridity/api/sessions" -H "Accept: application/json" -H "Content-Type: application/json" --data @- -D - -o /dev/null |',
        '  tr -d "\\r" | awk -F": " \'tolower($1)=="x-hm-authorization"{print $2}\') || true',
        'if [[ -z "$SESSION" ]]; then',
        '  problem "HCX Manager did not accept the login"',
        '  exit 1',
        'fi',
        '# The session token goes to curl from a private header file, never as an argument.',
        ...privateHeader('HCX_AUTH', 'x-hm-authorization:', 'SESSION'),
        'hcx() { curl -sS -f "https://${HCX}$1" -H "@${HCX_AUTH}" -H "Accept: application/json"; }',
        '',
        '# 4. Version, and the service meshes. VERIFY both paths on your HCX release.',
        "VERSION=$(hcx /hybridity/api/appliance/version 2>/dev/null | jq -r '.version // .buildVersion // empty') || true",
        'echo "HCX version: ${VERSION:-unknown (VERIFY the version path)}"',
        'MESHES=$(hcx /hybridity/api/interconnect/serviceMesh 2>/dev/null) || { problem "could not list service meshes (VERIFY the path)"; MESHES=\'{}\'; }',
        "jq -r '(.items // .data.items // [])[] | \"mesh \\(.name // .serviceMeshId): \\(.status // .state // \"?\")\"' <<<\"$MESHES\"",
        "BAD=$(jq '[(.items // .data.items // [])[] | select(((.status // .state // \"\") | ascii_upcase) | test(\"UP|OK|HEALTHY|DEPLOYED|SUCCESS\") | not)] | length' <<<\"$MESHES\")",
        '(( BAD == 0 )) || problem "${BAD} service mesh(es) not reporting up"',
        '',
        '# Logging out is best effort: a failure here does not change the result.',
        'curl -sS -X DELETE "https://${HCX}/hybridity/api/sessions" -H "@${HCX_AUTH}" >/dev/null 2>&1 || true',
        '(( PROBLEMS )) && echo "Not ready: fix the problems above before starting a wave." || echo "Ready."',
        'exit $PROBLEMS',
      ]);

      const checklist = [
        'HCX in VCF 9.1 — lifecycle and management pack checklist (manual items)',
        '',
        '[ ] HCX Manager is deployed and upgraded through VCF Operations in 9.1; confirm the',
        '    target version appears in fleet lifecycle before planning an upgrade mid-migration.',
        '[ ] The HCX management pack is installed in VCF Operations (see "Install or upgrade',
        '    a management pack"), and its account is collecting.',
        '[ ] Local-user password rotation and certificate rotation are done from the',
        '    management pack, not by hand, so VCF Operations stays the record.',
        '[ ] New service meshes in 9.1 use the enhanced Interconnect / Network Extension',
        '    architecture automatically; check existing meshes before mixing the two.',
        '[ ] No HCX upgrade is scheduled inside a migration wave window.',
        '[ ] A log bundle can be collected from the management pack (test it once).',
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `HCX readiness — ${hcx}`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Before each migration wave, and the morning of it.', worstCase: 'as often as someone runs it' },
        scope: {
          what: `HCX Manager ${hcx} and the solutions list in VCF Operations. Reads only.`,
          decidedBy: ['The HCX account’s read permissions.', 'The VCF Operations account’s read permissions.'],
          ifWrong: 'A report that says ready when it is not. Nothing is changed either way.',
        },
        guardrails: [
          { rule: 'Only GETs, a login and a logout', because: 'A readiness check that can change HCX is a migration risk of its own.' },
          { rule: 'Password from a mode-600 file, sent on stdin; the session token passed to curl from a private header file', because: 'Neither the HCX password nor the session token appears in a process list or a crontab.' },
        ],
        dryRun: ['It only reads; running it is the dry run.'],
        undo: ['Nothing to undo.'],
        told: ['Whoever runs it; the exit code for a pipeline gate.'],
        requires: ['openssl, jq and curl.', 'A read-only HCX account, and a VCF Operations account for the solutions check.'],
        files: {
          [`${base}.sh`]: script,
          'hcx-91-checklist.txt': checklist,
          'IMPORT.md': nothingToImportMd('the HCX readiness report', [
            `${base}.sh reads VCF Operations and HCX Manager and changes nothing. Run it before each migration wave from a host that can reach both; it exits non-zero on anything that should stop the wave.`,
            'hcx-91-checklist.txt is for a person. The HCX management pack it checks for is a .pak installed under Administration → Integrations → Repository.',
          ]),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: an HCX management pack for VCF Operations (password rotation for local users, certificate rotation, log bundle collection), and HCX Manager lifecycle through VCF Operations.',
          'POST /hybridity/api/sessions and the x-hm-authorization header are the long-standing HCX login. VERIFY: /hybridity/api/appliance/version and /hybridity/api/interconnect/serviceMesh and their field names on your HCX release — the script reports a problem rather than passing if they differ.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_app_monitoring',
    platform: PLATFORM,
    label: 'Application monitoring with Telegraf',
    group: 'Extend',
    description:
      'Application and OS monitoring through a cloud proxy, with Telegraf: the product-managed agent installed on vCenter VMs (named, or every member of a custom group) and its application services activated through the suite API, or open-source Telegraf onboarded to the cloud proxy on any Linux machine with the cloud proxy’s own helper. Each plugin row — Apache, MySQL, PostgreSQL, SQL Server, IIS, NGINX, ping or a custom script — has its target and settings; database credentials come from the environment at apply time and never reach a file here. Everything it sets up is enabled and collecting when the script ends.',
    inputs: [
      { id: 'cloud_proxy', label: 'Cloud proxy', control: 'text', default: 'cp01.example.com', hint: 'Its name as listed under cloud proxies (or its FQDN / IP for open-source Telegraf)' },
      {
        id: 'agent',
        label: 'Telegraf',
        control: 'select',
        options: [
          { value: 'product', label: 'Product-managed: installed on vCenter VMs by VCF Operations' },
          { value: 'opensource', label: 'Open-source Telegraf, onboarded to the cloud proxy (Linux; any machine)' },
        ],
        default: 'product',
      },
      {
        id: 'target_mode',
        label: 'On',
        control: 'select',
        options: [
          { value: 'vms', label: 'The VMs named below' },
          { value: 'group', label: 'Every VM in a custom group' },
        ],
        default: 'vms',
        showWhen: { input: 'agent', equals: ['product'] },
      },
      { id: 'vms', label: 'VMs or machines', control: 'textarea', default: 'app-web01\napp-db01', hint: 'One per line; for open-source Telegraf, the machines the script is run on' },
      { id: 'group', label: 'Custom group', control: 'text', default: 'Tier 1 Applications', showWhen: { input: 'target_mode', equals: ['group'] } },
      {
        id: 'plugins',
        label: 'Plugins',
        control: 'textarea',
        default: 'mysql | app-db01.example.com:3306 | user=svc-telegraf | MYSQL\napache | app-web01.example.com | status_path=/server-status?auto | \nping | 2001:db8::1 | count=3 | ',
        hint: 'Plugin | Target | Settings | Credential',
        help: 'Target: host, host:port, [IPv6]:port, a URL, or for a custom script its full path. Settings: key=value; … (apache status_path, nginx status_path, mysql user and tls, postgres user dbname sslmode, mssql user port, ping count, custom timeout and data_format). Credential: the prefix of the environment variables that hold the account — MYSQL reads MYSQL_PASSWORD (and MYSQL_USER when no user= is given).',
        options: [
          ...TELEGRAF_PLUGINS.map((plugin) => ({ value: plugin.value, label: plugin.label, group: 'Plugin' })),
        ],
      },
      { id: 'interval', label: 'Collect every (seconds)', control: 'number', default: 300, min: 10, max: 3600 },
      { id: 'os_metrics', label: 'Also collect OS metrics (CPU, memory, disk, network)', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const proxy = str(values, 'cloud_proxy', '').trim();
      const agent = str(values, 'agent', 'product');
      const mode = agent === 'product' ? str(values, 'target_mode', 'vms') : 'vms';
      const vms = str(values, 'vms', '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      const group = str(values, 'group', '').trim();
      const interval = num(values, 'interval', 300);
      const osMetrics = bool(values, 'os_metrics', true);
      const base = slugOf(name || 'app-monitoring', 'app-monitoring');

      const findings            = [];
      const rows = parseTelegrafRows(str(values, 'plugins', ''));
      for (const problem of rows.problems) findings.push(error('vcfops.telegraf.bad-row', problem, { source: SRC }));
      if (rows.rows.length === 0 && !osMetrics) findings.push(error('vcfops.telegraf.nothing', 'No plugin and no OS metrics: nothing would be collected.', { source: SRC }));
      if (!proxy) findings.push(error('vcfops.telegraf.no-proxy', 'Name the cloud proxy the agents report to.', { source: SRC }));
      if (mode === 'vms' && vms.length === 0) findings.push(error('vcfops.telegraf.no-targets', 'Name at least one VM or machine.', { source: SRC }));
      if (mode === 'group' && !group) findings.push(error('vcfops.telegraf.no-group', 'Name the custom group.', { source: SRC }));
      if (interval < 60) findings.push(warning('vcfops.telegraf.interval', `Every ${interval} seconds is more often than VCF Operations stores points (every 5 minutes by default).`, { remediation: 'Use 60 seconds or more; the extra samples cost the cloud proxy and the database and are averaged away.', source: SRC }));
      if (agent === 'opensource' && rows.rows.some((row) => row.plugin === 'iis')) {
        findings.push(error('vcfops.telegraf.iis-linux', 'IIS is Windows, and the open-source onboarding here is the Linux helper.', { remediation: 'Use the product-managed agent for Windows VMs, or onboard the Windows server with the cloud proxy’s telegraf-utils.ps1 (IMPORT.md says how).', source: SRC }));
      }
      if (mode === 'group' && rows.rows.some((row) => !['ping', 'custom'].includes(row.plugin) && !/localhost|127\.0\.0\.1|\[::1\]/.test(row.target))) {
        findings.push(info('vcfops.telegraf.group-targets', 'Plugin targets are fixed hosts, but the group may hold many VMs: each VM’s agent would monitor the same target.', { remediation: 'For per-VM services write the target as localhost (the service on the VM itself).', source: SRC }));
      }
      if (proxy && isIpv6(proxy)) findings.push(info('vcfops.telegraf.ipv6', 'The cloud proxy is addressed by IPv6: the agents need an IPv6 route to it on 443, 4505 and 4506.', { source: SRC }));

      // Open-source Telegraf input configuration, per plugin; credentials as ${VAR}.
      const toml = [
        `# Telegraf inputs for VCF Operations application monitoring (cloud proxy ${proxy}).`,
        '# Secrets are ${VARIABLES} from the telegraf service environment, never literals.',
        '',
        '[agent]',
        `  interval = "${interval}s"`,
        '',
        ...(osMetrics ? ['[[inputs.cpu]]', '  percpu = false', '  totalcpu = true', '[[inputs.mem]]', '[[inputs.disk]]', '  ignore_fs = ["tmpfs", "devtmpfs", "overlay"]', '[[inputs.diskio]]', '[[inputs.net]]', '[[inputs.system]]', ''] : []),
        ...rows.rows.flatMap((row) => [...telegrafInput(row, interval), '']),
      ].join('\n');

      const envNeeded = [...new Set(rows.rows.flatMap((row) => (row.credential ? [`${row.credential}_PASSWORD`, ...(row.settings.user ? [] : [`${row.credential}_USER`])] : [])))];

      // Product-managed: the suite API calls (VERIFY), each checked, with the UI as the fallback.
      const services = rows.rows.map((row) => ({
        serviceName: row.plugin === 'custom' ? 'script' : row.plugin === 'mssql' ? 'mssql' : row.plugin,
        target: row.target,
        settings: row.settings,
        credential: row.credential ?? '',
      }));
      const productScript = [
        '#!/usr/bin/env bash',
        `# Product-managed Telegraf through cloud proxy ${proxy}: install the agent on`,
        `# ${mode === 'group' ? `every VM in the custom group "${group}"` : `${vms.length} VM(s)`}, then activate the application services.`,
        '#',
        '# Applies when run; --dry-run lists the VMs and the bodies and sends nothing.',
        `# Credentials: ${envNeeded.join(', ') || 'none'} from the environment, sent in the body on stdin.`,
        '#',
        '# VERIFY: /suite-api/api/applications/agents and .../agents/services are the',
        '# application-monitoring calls of the suite API as used from 8.x; the script checks',
        '# every answer and, if a path is not there on your release, stops and says how to',
        '# do it in the interface (Operate > Workloads > Applications > Manage Telegraf Agents).',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        ...envNeeded.map((v) => `: "\${${v}:?set ${v} (from your secret store) for the plugin that needs it}"`),
        'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        `API="https://\${VCFOPS_HOST}/suite-api/api"`,
        `get() { curl -sS -f -G "$API/$1" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" "\${@:2}"; }`,
        '# send METHOD PATH: body on stdin; prints the HTTP code, the answer in $WORK/out.json.',
        'WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/apm.XXXXXX")',
        `trap 'rm -rf "$WORK" "\${${authHeader(PLATFORM).slice(3, -1)}:-}"' EXIT`,
        `send() { curl -sS -o "$WORK/out.json" -w '%{http_code}' -X "$1" "$API/$2" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @- || echo 000; }`,
        'manual() {',
        '  echo "The suite API did not take the call (HTTP $1). Do it in the interface instead:" >&2',
        '  echo "  Operate > Workloads > Applications > Manage Telegraf Agents: select the VMs, Install, and choose the cloud proxy;" >&2',
        '  echo "  then, per VM, Configure each application service below with its target and account." >&2',
        '  exit 1',
        '}',
        '',
        `PROXY_ID=$(get collectors | jq -r --arg n '${sq(proxy)}' '[(.collector // .collectors // [])[] | select(.name == $n or .hostName == $n) | .id] | .[0] // empty')`,
        `[[ -n "$PROXY_ID" ]] || { echo "No cloud proxy named '${sq(proxy)}'. Cloud proxies:" >&2; get collectors | jq -r '(.collector // .collectors // [])[] | "  " + .name' >&2; exit 2; }`,
        ...(mode === 'group'
          ? [
              `GROUP_ID=$(get resources/groups --data-urlencode pageSize=10000 | jq -r --arg n '${sq(group)}' '[.groups[]? | select(.resourceKey.name == $n) | .id] | if length == 1 then .[0] else empty end')`,
              `[[ -n "$GROUP_ID" ]] || { echo "Expected exactly one custom group named '${sq(group)}'." >&2; exit 2; }`,
              'VM_IDS=$(get "resources/groups/${GROUP_ID}/members" --data-urlencode pageSize=10000 | jq -c \'[.resourceList[]? | select(.resourceKey.resourceKindKey == "VirtualMachine") | .identifier]\')',
            ]
          : [
              'VM_IDS=[]',
              `for vm in ${vms.map((vm) => `'${sq(vm)}'`).join(' ')}; do`,
              '  id=$(get resources --data-urlencode resourceKind=VirtualMachine --data-urlencode "name=$vm" | jq -r --arg n "$vm" \'[.resourceList[]? | select(.resourceKey.name == $n) | .identifier] | if length == 1 then .[0] else empty end\')',
              '  [[ -n "$id" ]] || { echo "Expected exactly one VM named $vm." >&2; exit 2; }',
              '  VM_IDS=$(jq -c --arg i "$id" \'. + [$i]\' <<<"$VM_IDS")',
              'done',
            ]),
        'N=$(jq length <<<"$VM_IDS")',
        '(( N > 0 )) || { echo "No VMs to monitor." >&2; exit 2; }',
        'echo "${N} VM(s), cloud proxy ${PROXY_ID}."',
        '',
        '# 1. The agent. VERIFY: body fields.',
        'jq -n --arg p "$PROXY_ID" --argjson v "$VM_IDS" \'{collectorId: $p, vmIds: $v}\' > "$WORK/install.json"',
        'if (( DRY_RUN )); then echo "DRY RUN: would POST applications/agents:"; jq . "$WORK/install.json"; else',
        '  code=$(send POST applications/agents < "$WORK/install.json")',
        '  [[ "$code" == 2* ]] || manual "$code"',
        '  TASK=$(jq -r \'.taskId // .id // empty\' "$WORK/out.json")',
        '  for _ in $(seq 1 90); do',
        '    [[ -n "$TASK" ]] || break',
        '    s=$(get "applications/agents/${TASK}/status" | jq -r \'.status // .state // "UNKNOWN"\') || s=UNKNOWN',
        '    case "$s" in SUCCESS|SUCCEEDED|COMPLETED|FINISHED) echo "Agents installed."; break ;; FAILED|ERROR) echo "The agent install failed; see Manage Telegraf Agents." >&2; exit 1 ;; esac',
        '    sleep 20',
        '  done',
        'fi',
        '',
        '# 2. The application services, activated on every VM, with the account from the',
        '#    environment (jq env.*, so no secret is an argument). VERIFY: body fields.',
        `jq -n --argjson v "$VM_IDS" --argjson s '${sq(JSON.stringify(services))}' --argjson i ${interval} '`,
        '  {resourceIds: $v, services: [$s[] | {serviceName, isActivated: true, collectionInterval: $i,',
        '     configuration: (.settings + {target: .target}',
        '       + (if .credential != "" then {username: (.settings.user // env[.credential + "_USER"]), password: env[.credential + "_PASSWORD"]} else {} end))}]}\' > "$WORK/services.json"',
        'if (( DRY_RUN )); then echo "DRY RUN: would POST applications/agents/services for:"; jq -r \'.services[] | "  \\(.serviceName) \\(.configuration.target)"\' "$WORK/services.json"; echo "Dry run: nothing was changed."; exit 0; fi',
        'code=$(send POST applications/agents/services < "$WORK/services.json")',
        '[[ "$code" == 2* ]] || manual "$code"',
        'echo "Application services activated. Objects appear under Operate > Workloads > Applications within two collection cycles."',
        '# Undo: Manage Telegraf Agents > Uninstall on the VMs (or DELETE applications/agents with the same body).',
        '',
      ].join('\n');

      const onboardScript = [
        '#!/usr/bin/env bash',
        `# Onboard open-source Telegraf on this machine to cloud proxy ${proxy}, with the`,
        '# inputs in telegraf.d/. Run as root on each machine, with telegraf installed from',
        '# the InfluxData repository.',
        '#',
        '# It takes a VCF Operations token (from the identity broker, with the API token in',
        '# VCF_API_TOKEN_FILE, mode 600), fetches the cloud proxy’s helper and runs it in',
        '# opensource mode (which writes the output to the cloud proxy, port 443 in 9.1),',
        '# installs the inputs, puts the plugin accounts in a root-only environment file for',
        '# the service, tests the configuration and restarts telegraf. --dry-run tests only.',
        '#',
        '# The helper takes the token as an argument (-t): the token is short-lived and is',
        '# fetched for this run only; run it where other users cannot read the process list.',
        'set -euo pipefail',
        `PROXY='${sq(proxy)}'`,
        ': "${VCFOPS_HOST:?set VCFOPS_HOST, the VCF Operations FQDN or IP}"',
        ': "${VCF_IDB_HOST:?set VCF_IDB_HOST to the VCF Identity Broker}"',
        ': "${VCF_API_TOKEN_FILE:?set VCF_API_TOKEN_FILE to a mode-600 file holding the identity broker API token}"',
        ...envNeeded.map((v) => `: "\${${v}:?set ${v} (from your secret store) for the plugin that needs it}"`),
        '(( EUID == 0 )) || { echo "Run as root." >&2; exit 2; }',
        'for tool in curl jq telegraf systemctl; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done',
        'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/otel.XXXXXX")',
        "trap 'rm -rf \"$WORK\"' EXIT",
        '',
        '# Test the inputs first, with the accounts in this environment.',
        'cp "$HERE/telegraf.d/vcfops-inputs.conf" "$WORK/"',
        'telegraf --config-directory "$WORK" --test --test-wait 10 >/dev/null || { echo "telegraf --test failed on the inputs; nothing was changed." >&2; exit 1; }',
        'if (( DRY_RUN )); then echo "DRY RUN: the inputs test clean. Nothing was changed."; exit 0; fi',
        '',
        '# A bearer token from the identity broker (the API token goes in the form on stdin).',
        "TOKEN=$( { printf 'grant_type=urn:custom:vcf:params:oauth:grant-type:api-token&api_token='; jq -jRr @uri < \"$VCF_API_TOKEN_FILE\"; } |",
        '  curl -sS -f -X POST "https://${VCF_IDB_HOST}/acs/t/CUSTOMER/token" -H "Content-Type: application/x-www-form-urlencoded" --data-binary @- | jq -r .access_token)',
        '[[ -n "$TOKEN" && "$TOKEN" != null ]] || { echo "No token from the identity broker." >&2; exit 1; }',
        '',
        '# The helper, from the cloud proxy. VERIFY the path on your release (9.1 names the',
        '# Linux helper open_source_telegraf_monitor.sh; earlier releases telegraf-utils.sh).',
        'HELPER=""',
        'for p in downloads/salt/open_source_telegraf_monitor.sh downloads/salt/telegraf-utils.sh; do',
        '  if curl -sS -f -k "https://${PROXY}/${p}" -o "$WORK/helper.sh"; then HELPER="$WORK/helper.sh"; break; fi',
        'done',
        '[[ -n "$HELPER" ]] || { echo "Could not fetch the helper from the cloud proxy. Download it from Operate > Workloads > Applications > Manage Telegraf Agents and run: helper opensource -c <proxy> -t <token> -v <ops> -d /etc/telegraf/telegraf.d -e $(command -v telegraf)" >&2; exit 1; }',
        'chmod 700 "$HELPER"',
        'bash "$HELPER" opensource -c "$PROXY" -t "$TOKEN" -v "$VCFOPS_HOST" -d /etc/telegraf/telegraf.d -e "$(command -v telegraf)"',
        'unset TOKEN',
        '',
        'install -m 644 "$HERE/telegraf.d/vcfops-inputs.conf" /etc/telegraf/telegraf.d/vcfops-inputs.conf',
        '# The plugin accounts, for the service only: root-owned, mode 600.',
        'umask 077',
        ': > /etc/telegraf/vcfops.env',
        ...envNeeded.map((v) => `printf '%s=%s\\n' ${v} "$${v}" >> /etc/telegraf/vcfops.env`),
        'mkdir -p /etc/systemd/system/telegraf.service.d',
        "printf '[Service]\\nEnvironmentFile=/etc/telegraf/vcfops.env\\n' > /etc/systemd/system/telegraf.service.d/vcfops.conf",
        'systemctl daemon-reload',
        'systemctl enable telegraf',
        'systemctl restart telegraf',
        'sleep 5',
        'systemctl is-active --quiet telegraf || { echo "telegraf did not start: journalctl -u telegraf" >&2; exit 1; }',
        'echo "Onboarded. The machine appears under Operate > Workloads > Applications within two collection cycles."',
        '# Undo: remove /etc/telegraf/telegraf.d/vcfops-inputs.conf, the helper-written output file and',
        '# /etc/telegraf/vcfops.env and the drop-in, then systemctl restart telegraf.',
        '',
      ].join('\n');

      const script = agent === 'product' ? productScript : onboardScript;
      const scriptName = agent === 'product' ? 'apply-app-monitoring.sh' : 'onboard-telegraf.sh';
      const where = mode === 'group' ? `every VM in the custom group "${group}"` : vms.join(', ') || 'no machine';

      return {
        platform: PLATFORM,
        title: `Application monitoring — ${rows.rows.map((r) => r.plugin).join(', ') || 'OS only'} on ${where}, via ${proxy || '?'}`,
        effect: 'reversible',
        trigger: { kind: 'manual', detail: `Run once${agent === 'opensource' ? ' on each machine' : ''}; the agents then collect every ${interval} seconds.`, worstCase: `every ${interval} seconds per plugin per machine, for as long as the agent runs` },
        scope: {
          what: `${agent === 'product' ? 'The product-managed Telegraf agent' : 'Open-source Telegraf'} on ${where}, reporting to cloud proxy ${proxy}, with ${rows.rows.length} plugin(s)${osMetrics ? ' and OS metrics' : ''}.`,
          decidedBy: [mode === 'group' ? `The members of "${group}" when it runs — a VM added to the group later is not included until it is run again.` : 'The machines named.', 'The plugin targets, which are fixed hosts and URLs.'],
          ifWrong: 'Agents on machines nobody meant to monitor: licence use, cloud proxy load, and a database login attempted from each.',
        },
        guardrails: [
          { rule: 'Every VM, the group and the cloud proxy are found by exact name, and the script stops on none or more than one', because: 'An agent pushed to the wrong VM of the same name runs a database login against a system nobody approved.' },
          { rule: 'Database accounts come from the environment and are sent on stdin or kept in a root-only file for the service', because: 'A monitoring password in a config file in a repository is the one every scanner finds.' },
          { rule: agent === 'product' ? 'Each suite API answer is checked; a missing call stops the script with the interface steps' : 'The inputs are tested with telegraf --test before anything is changed', because: agent === 'product' ? 'An install that half worked and reports success leaves VMs unmonitored with nothing to say so.' : 'A telegraf that fails to parse its configuration stops collecting everything, not just the new input.' },
          { rule: '--dry-run lists what would be done and sends nothing', because: 'The agent install touches every VM in scope.' },
        ],
        dryRun: [`${scriptName} --dry-run ${agent === 'product' ? 'resolves the VMs and prints the bodies' : 'tests the inputs with telegraf --test'} and changes nothing.`],
        undo: [agent === 'product' ? 'Operate > Workloads > Applications > Manage Telegraf Agents: select the VMs and Uninstall.' : 'Remove the inputs file, the helper-written output file, /etc/telegraf/vcfops.env and the drop-in, and restart telegraf (the last lines of the script list them).'],
        told: ['Nobody; the machines appear under Operate > Workloads > Applications, and a failing agent raises an agent-health alert.'],
        requires: [
          `Cloud proxy ${proxy}, reachable from the machines on 443, 4505 and 4506 (8443 is deprecated in 9.1).`,
          agent === 'product' ? 'VMware Tools running on each VM, and a vCenter account on the adapter allowed to run guest operations.' : 'telegraf from the InfluxData repository on each machine, and an identity broker API token.',
          ...(envNeeded.length > 0 ? [`${envNeeded.join(', ')} set from your secret store when the script runs.`] : []),
          'jq and curl.',
        ],
        files: {
          [scriptName]: script,
          'telegraf.d/vcfops-inputs.conf': `${toml}\n`,
          'IMPORT.md': nothingToImportMd('application monitoring with Telegraf', [
            agent === 'product'
              ? `${scriptName}: run it once from any host that reaches VCF Operations (--dry-run first). It installs the product-managed agent on ${where} through cloud proxy ${proxy} and activates the services.`
              : `${scriptName}: copy the folder to each machine and run it as root (--dry-run first). It onboards the machine’s open-source Telegraf to cloud proxy ${proxy} with the cloud proxy’s helper and installs telegraf.d/vcfops-inputs.conf.`,
            'telegraf.d/vcfops-inputs.conf is the open-source Telegraf input configuration for the same plugins — the reference for what each one collects, and what the open-source route installs.',
            'Windows servers with open-source Telegraf: download telegraf-utils.ps1 from the cloud proxy (Manage Telegraf Agents), run it with opensource -c <proxy> -t <token> -v <VCF Operations> -d <telegraf.d> -e <telegraf.exe>, then copy the inputs file in and restart the Telegraf service.',
          ]),
        },
        notes: [
          'CONFIRMED (VCF 9.1 docs): product-managed Telegraf is installed from Operate > Workloads > Applications > Manage Telegraf Agents, cloud proxies in an HA collector group share the agents, port 443 replaces 8443; open-source Telegraf is onboarded with the cloud proxy’s helper in opensource mode (-c proxy, -t token, -v VCF Operations, -d config dir, -e telegraf binary), with a token from the identity broker in 9.1.',
          'VERIFY: /suite-api/api/applications/agents, /agents/{task}/status and /agents/services and their body fields are not in the 9.1 public reference as read; the script checks every answer and stops with the interface steps if one is refused.',
          'VERIFY: the helper’s path on the cloud proxy (the script tries downloads/salt/open_source_telegraf_monitor.sh, then telegraf-utils.sh).',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfops_hcx_lifecycle',
    platform: PLATFORM,
    label: 'HCX lifecycle through VCF Operations',
    group: 'Extend',
    description:
      'HCX Manager deployed, upgraded and brought under monitoring from VCF Operations fleet lifecycle, as 9.1 does it: an inventory of the HCX instances fleet lifecycle knows; an upgrade plan to a target version with the enhanced precheck, applied only with a change reference, a passed precheck and a recent backup; or a new HCX Manager (Cloud or Connector) deployed from a spec with its passwords read from files. Afterwards the HCX account is added to the HCX management pack so its password and certificate rotation run from VCF Operations.',
    inputs: [
      {
        id: 'action',
        label: 'Do',
        control: 'select',
        options: [
          { value: 'upgrade', label: 'Upgrade HCX to a target version' },
          { value: 'deploy', label: 'Deploy a new HCX Manager' },
          { value: 'inventory', label: 'List the HCX instances and their versions' },
        ],
        default: 'upgrade',
      },
      { id: 'lcm_host', label: 'Fleet lifecycle host', control: 'text', default: 'fleet-lcm.example.com', hint: 'Where /fleet-lcm/v1 answers (often the VCF Operations FQDN)' },
      { id: 'hcx_fqdn', label: 'HCX Manager FQDN', control: 'text', default: 'hcx-mgr01.example.com' },
      { id: 'target_version', label: 'Target version', control: 'text', default: '9.1.0', showWhen: { input: 'action', equals: ['upgrade'] } },
      { id: 'backup_hours', label: 'Refuse unless backed up within (hours)', control: 'number', default: 24, min: 1, max: 720, showWhen: { input: 'action', equals: ['upgrade'] } },
      {
        id: 'role',
        label: 'Role',
        control: 'select',
        options: [
          { value: 'CLOUD', label: 'HCX Cloud (the destination side)' },
          { value: 'CONNECTOR', label: 'HCX Connector (the source side)' },
        ],
        default: 'CLOUD',
        showWhen: { input: 'action', equals: ['deploy'] },
      },
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-mgmt.example.com', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'cluster', label: 'Cluster', control: 'text', default: 'mgmt-cluster01', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'datastore', label: 'Datastore', control: 'text', default: 'mgmt-vsan01', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'portgroup', label: 'Management port group', control: 'text', default: 'mgmt-vm-pg', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'ip', label: 'IPv4 address / prefix', control: 'text', default: '10.0.10.40/24', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'gateway', label: 'IPv4 gateway', control: 'text', default: '10.0.10.1', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'ipv6', label: 'IPv6 address / prefix', control: 'text', default: '', placeholder: 'None', hint: 'Dual stack when given', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'ipv6_gateway', label: 'IPv6 gateway', control: 'text', default: '', placeholder: 'None', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'dns', label: 'DNS servers', control: 'text', default: '10.0.0.53', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'ntp', label: 'NTP servers', control: 'text', default: 'ntp.example.com', showWhen: { input: 'action', equals: ['deploy'] } },
      { id: 'add_account', label: 'Add the HCX account to the HCX management pack afterwards', control: 'toggle', default: true },
      { id: 'collector_group', label: 'Collector group for the account', control: 'text', default: '', placeholder: 'The default', showWhen: { input: 'add_account', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const action = str(values, 'action', 'upgrade');
      const lcmHost = str(values, 'lcm_host', '').trim();
      const hcx = str(values, 'hcx_fqdn', '').trim();
      const target = str(values, 'target_version', '').trim();
      const backupHours = num(values, 'backup_hours', 24);
      const role = str(values, 'role', 'CLOUD');
      const ip = str(values, 'ip', '').trim();
      const gateway = str(values, 'gateway', '').trim();
      const ipv6 = str(values, 'ipv6', '').trim();
      const ipv6Gateway = str(values, 'ipv6_gateway', '').trim();
      const dns = listOf(str(values, 'dns', ''));
      const ntp = listOf(str(values, 'ntp', ''));
      const addAccount = bool(values, 'add_account', true);
      const collectorGroup = str(values, 'collector_group', '').trim();
      const base = slugOf(name || 'hcx-lifecycle', 'hcx-lifecycle');

      const findings            = [];
      if (!hcx) findings.push(error('vcfops.hcxlcm.no-fqdn', 'Name the HCX Manager.', { source: SRC }));
      if (!lcmHost) findings.push(error('vcfops.hcxlcm.no-lcm', 'Name the fleet lifecycle host.', { source: SRC }));
      if (action === 'upgrade' && !/^\d+\.\d+(\.\d+){0,2}$/.test(target)) findings.push(error('vcfops.hcxlcm.bad-version', `"${target}" is not a version (9.1.0).`, { source: SRC }));
      if (action === 'deploy') {
        const [addr = '', prefix = ''] = ip.split('/');
        if (!isIp(addr) || familyOf(addr) !== 4 || !/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) findings.push(error('vcfops.hcxlcm.bad-ip', `"${ip}" is not an IPv4 address with a prefix (10.0.10.40/24).`, { source: SRC }));
        if (!isIp(gateway) || familyOf(gateway) !== 4) findings.push(error('vcfops.hcxlcm.bad-gateway', `"${gateway}" is not an IPv4 gateway.`, { source: SRC }));
        if (ipv6) {
          const [a6 = '', p6 = ''] = ipv6.split('/');
          if (!isIpv6(a6) || !/^\d{1,3}$/.test(p6) || Number(p6) > 128) findings.push(error('vcfops.hcxlcm.bad-ipv6', `"${ipv6}" is not an IPv6 address with a prefix (2001:db8::40/64).`, { source: SRC }));
          if (!ipv6Gateway || !isIpv6(ipv6Gateway)) findings.push(error('vcfops.hcxlcm.bad-ipv6-gateway', 'A dual-stack HCX Manager needs an IPv6 gateway.', { source: SRC }));
        }
        if (dns.length === 0) findings.push(error('vcfops.hcxlcm.no-dns', 'HCX Manager needs a DNS server: it is reached and it registers by name.', { source: SRC }));
        if (ntp.length === 0) findings.push(warning('vcfops.hcxlcm.no-ntp', 'No NTP server: HCX pairing and certificates fail on clock skew.', { source: SRC }));
      }
      if (action === 'upgrade') findings.push(info('vcfops.hcxlcm.window', 'Do not upgrade HCX inside a migration wave: replication and network extension restart.', { source: SRC }));

      const [addr4 = '', prefix4 = '24'] = ip.split('/');
      const [addr6 = '', prefix6 = '64'] = ipv6.split('/');
      const deploySpec = {
        componentType: 'HCX',
        // VERIFY: the deploy body fields of the fleet lifecycle component deployment.
        spec: {
          role,
          fqdn: hcx,
          vcenter: str(values, 'vcenter', ''),
          placement: { cluster: str(values, 'cluster', ''), datastore: str(values, 'datastore', ''), network: str(values, 'portgroup', '') },
          network: {
            ipv4: { address: addr4, prefixLength: Number(prefix4), gateway },
            ...(ipv6 ? { ipv6: { address: addr6, prefixLength: Number(prefix6), gateway: ipv6Gateway } } : {}),
            dnsServers: dns,
            ntpServers: ntp,
          },
          adminPassword: '<set by hcx-lifecycle.sh from HCX_ADMIN_PASSWORD_FILE>',
          rootPassword: '<set by hcx-lifecycle.sh from HCX_ROOT_PASSWORD_FILE>',
        },
      };

      const script = [
        '#!/usr/bin/env bash',
        `# HCX lifecycle through VCF Operations fleet lifecycle: ${action} for ${hcx}.`,
        '#',
        '#   ./hcx-lifecycle.sh                              ' + (action === 'inventory' ? 'list the HCX instances (read)' : action === 'upgrade' ? `plan, enhanced precheck, apply to ${target}` : 'deploy HCX Manager from hcx-deploy.json'),
        '#   ./hcx-lifecycle.sh --dry-run                    read and check only',
        '#   CHANGE=<ref> is required to change anything.',
        '#',
        '# The Fleet LCM token comes from exchanging the VCF Operations token at',
        '# /suite-api/api/auth/token/exchange (serviceKeys fleet-lcm), and goes to curl from',
        '# a private header file, never as an argument.',
        'set -euo pipefail',
        '',
        ...authPreamble(PLATFORM),
        'command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }',
        `LCM_HOST="\${FLEET_LCM_HOST:-${sq(lcmHost)}}"`,
        `HCX_FQDN='${sq(hcx)}'`,
        'DRY_RUN=0; [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1',
        'HERE=$(cd "$(dirname "$0")" && pwd)',
        'LCM_HDR=$(umask 077; mktemp "${TMPDIR:-/tmp}/lcm.XXXXXX")',
        `trap 'rm -f "$LCM_HDR" "\${${authHeader(PLATFORM).slice(3, -1)}:-}"' EXIT`,
        't=$(curl -sS -f -X POST "https://${VCFOPS_HOST}/suite-api/api/auth/token/exchange" \\',
        `  -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -H "Content-Type: application/json" \\`,
        '  --data \'{"serviceKeys":["fleet-lcm"]}\' | jq -r \'.jwtToken // empty\') || t=""',
        '[[ -n "$t" ]] || { echo "Could not get a Fleet LCM token." >&2; exit 1; }',
        "printf 'Authorization: Bearer %s\\n' \"$t\" > \"$LCM_HDR\"; unset t",
        'lcm() { local m="$1" p="$2"; shift 2; curl -sS -f -X "$m" "https://${LCM_HOST}/fleet-lcm/v1${p}" -H "@${LCM_HDR}" -H "Accept: application/json" -H "Content-Type: application/json" "$@"; }',
        'wait_task() {',
        '  local s="UNKNOWN"',
        '  for _ in $(seq 1 540); do',
        '    s=$(lcm GET "/tasks/$1" | jq -r \'.status // "UNKNOWN"\') || s=UNKNOWN',
        '    case "$s" in SUCCEEDED) echo "  task $1: SUCCEEDED"; return 0 ;; FAILED|CANCELLED|CANCELED) echo "  task $1: $s" >&2; return 1 ;; esac',
        '    sleep 20',
        '  done',
        '  echo "  task $1: still $s after three hours" >&2; return 1',
        '}',
        'need_change() { [[ -n "${CHANGE:-}" ]] || { echo "Set CHANGE to the change reference to go on." >&2; exit 2; }; }',
        '',
        '# The HCX instances fleet lifecycle knows.',
        "HCXS=$(lcm GET /components | jq -c '[(.elements // .components // .)[]? | select(((.type // .componentType // \"\") | ascii_upcase) | test(\"HCX\"))]')",
        'jq -r \'.[] | "  \\(.fqdn // .name)\\t\\(.version)\\t\\(.status // "")"\' <<<"$HCXS"',
        ...(action === 'upgrade'
          ? [
              'jq -e --arg f "$HCX_FQDN" \'[.[] | select((.fqdn // .name) == $f)] | length == 1\' <<<"$HCXS" >/dev/null || { echo "Fleet lifecycle does not list ${HCX_FQDN} as an HCX component." >&2; exit 2; }',
              '',
              `# The newest backup of that HCX Manager must be under ${backupHours} hours old.`,
              "AGE=$(lcm GET /sddc-lcms | jq -r '(if type == \"array\" then . else (.elements // .sddcLcms // []) end)[] | (.id // .sddcLcmId)' | while read -r id; do lcm GET \"/sddc-lcms/${id}/backups?pageSize=100\" | jq -r --arg f \"$HCX_FQDN\" '.backups[]? | select(((.componentType // \"\") | ascii_upcase | test(\"HCX\")) and ((.name // .fqdn // \"\") == $f)) | (.points // [] | map(tostring | sub(\"\\\\.[0-9]+\"; \"\") | (try fromdateiso8601 catch (try tonumber catch null))) | map(select(. != null)) | max) | select(. != null) | ((now - (if . > 100000000000 then . / 1000 else . end)) / 3600 | floor)'; done | sort -n | head -n 1)",
              `if [[ -z "$AGE" ]] || (( AGE > ${backupHours} )); then echo "Refusing: no backup of \${HCX_FQDN} in the last ${backupHours}h (newest: \${AGE:-none}h). Back it up from fleet lifecycle first." >&2; exit 1; fi`,
              'echo "Backup: ${AGE}h old."',
              '',
              `BODY=$(jq -n --arg v '${sq(target)}' --arg f "$HCX_FQDN" '{spec: {desiredSoftware: {version: $v, components: []}, componentsFilter: ["HCX"], scope: {type: "MANAGEMENT", componentFqdns: [$f]}}}')`,
              'if (( DRY_RUN )); then echo "DRY RUN: would POST /fleet-lcm/v1/upgrade-plans:"; jq . <<<"$BODY"; exit 0; fi',
              'PLAN=$(lcm POST /upgrade-plans --data "$BODY")',
              "PLAN_ID=$(jq -r '.id // .planId // empty' <<<\"$PLAN\")",
              '[[ -n "$PLAN_ID" ]] || { echo "No plan id came back." >&2; exit 1; }',
              "T=$(lcm POST \"/upgrade-plans/${PLAN_ID}?action=precheck\" --data '{\"precheckType\":\"ENHANCED\"}' | jq -r '.taskId // .id // empty')",
              '[[ -z "$T" ]] || wait_task "$T" || { echo "The enhanced precheck did not succeed." >&2; exit 1; }',
              'lcm GET "/upgrade-plans/${PLAN_ID}" > "precheck-${PLAN_ID}.json"',
              "BAD=$(jq -r '[(.components | if type == \"object\" then .elements else . end)[]? | select(((.precheck.status // \"\") | ascii_upcase | test(\"^(SUCCEEDED|SUCCESSFUL|COMPLETED|PASSED)$\")) | not)] | length' \"precheck-${PLAN_ID}.json\")",
              '[[ "$BAD" == 0 ]] || { echo "Refusing: ${BAD} component(s) did not pass the precheck; see precheck-${PLAN_ID}.json." >&2; exit 1; }',
              'need_change',
              'echo "Change ${CHANGE}: applying plan ${PLAN_ID}."',
              "T=$(lcm POST \"/upgrade-plans/${PLAN_ID}?action=apply\" --data '{}' | jq -r '.taskId // .id // empty')",
              '[[ -n "$T" ]] || { echo "No task id returned; follow the plan in Fleet management > Lifecycle." >&2; exit 1; }',
              'wait_task "$T"',
            ]
          : []),
        ...(action === 'deploy'
          ? [
              'if jq -e --arg f "$HCX_FQDN" \'[.[] | select((.fqdn // .name) == $f)] | length > 0\' <<<"$HCXS" >/dev/null; then echo "${HCX_FQDN} is already managed by fleet lifecycle; nothing to deploy." >&2; exit 1; fi',
              ': "${HCX_ADMIN_PASSWORD_FILE:?set HCX_ADMIN_PASSWORD_FILE to a mode-600 file holding the HCX admin password}"',
              ': "${HCX_ROOT_PASSWORD_FILE:?set HCX_ROOT_PASSWORD_FILE to a mode-600 file holding the HCX root password}"',
              'if getent hosts "$HCX_FQDN" >/dev/null 2>&1; then echo "DNS: ${HCX_FQDN} resolves."; else echo "Refusing: ${HCX_FQDN} does not resolve; add its forward and reverse records first." >&2; exit 1; fi',
              'if (( DRY_RUN )); then echo "DRY RUN: would POST /fleet-lcm/v1/components with hcx-deploy.json and the passwords from their files. Nothing was changed."; exit 0; fi',
              'need_change',
              'BODY=$(jq --rawfile a "$HCX_ADMIN_PASSWORD_FILE" --rawfile r "$HCX_ROOT_PASSWORD_FILE" \'.spec.adminPassword = ($a | rtrimstr("\\n")) | .spec.rootPassword = ($r | rtrimstr("\\n"))\' "$HERE/hcx-deploy.json")',
              '# VERIFY: the deployment path. If it is refused, deploy from Fleet management >',
              '# Lifecycle > Components > HCX > Deploy with the values in hcx-deploy.json.',
              'R=$(lcm POST /components --data-binary @- <<<"$BODY") || { echo "The deployment was refused; deploy from Fleet management > Lifecycle > Components > HCX with hcx-deploy.json." >&2; exit 1; }',
              'unset BODY',
              "T=$(jq -r '.taskId // .id // empty' <<<\"$R\")",
              '[[ -n "$T" ]] || { echo "No task id returned; follow it in Fleet management > Lifecycle." >&2; exit 1; }',
              'echo "Change ${CHANGE}: deploying ${HCX_FQDN}."',
              'wait_task "$T"',
            ]
          : []),
        ...(addAccount && action !== 'inventory'
          ? [
              '',
              '# The HCX management pack account, so password and certificate rotation and log',
              '# bundles run from VCF Operations. The credential is one already under',
              '# Integrations > Credentials, named in HCX_CREDENTIAL_ID. VERIFY: adapter kind HCXAdapter.',
              ': "${HCX_CREDENTIAL_ID:?set HCX_CREDENTIAL_ID to the id of the HCX credential under Integrations > Credentials}"',
              `OPS="https://\${VCFOPS_HOST}/suite-api/api"`,
              `if curl -sS -f -G "$OPS/adapters" --data-urlencode adapterKindKey=HCXAdapter -H "${authHeader(PLATFORM)}" -H "Accept: application/json" | jq -e --arg f "$HCX_FQDN" '[.adapterInstancesInfoDto[]? | select(any(.resourceKey.resourceIdentifiers[]?; .value == $f))] | length > 0' >/dev/null; then`,
              '  echo "The HCX management pack already has an account for ${HCX_FQDN}."',
              'else',
              `  ACCOUNT=$(jq -n --arg f "$HCX_FQDN" --arg c "$HCX_CREDENTIAL_ID" --arg g '${sq(collectorGroup)}' '{name: $f, adapterKindKey: "HCXAdapter", resourceIdentifiers: [{name: "HCX_HOST", value: $f}], credential: {id: $c}} + (if $g != "" then {collectorGroupName: $g} else {} end)')`,
              `  ID=$(curl -sS -f -X POST "$OPS/adapters" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" -H "Content-Type: application/json" --data-binary @- <<<"$ACCOUNT" | jq -r '.id // empty') || ID=""`,
              '  [[ -n "$ID" ]] || { echo "The account was not created: add it under Integrations > Accounts > HCX." >&2; exit 1; }',
              `  curl -sS -f -X PUT "$OPS/adapters/\${ID}/monitoringstate/start" -H "${authHeader(PLATFORM)}" -H "Accept: application/json" >/dev/null`,
              '  echo "HCX account ${ID} created and collecting."',
              'fi',
            ]
          : []),
        '',
      ].join('\n');

      return {
        platform: PLATFORM,
        title: `HCX lifecycle — ${action === 'upgrade' ? `upgrade ${hcx} to ${target}` : action === 'deploy' ? `deploy ${hcx} (${role === 'CLOUD' ? 'Cloud' : 'Connector'})` : 'inventory'}`,
        effect: action === 'inventory' ? 'read' : action === 'deploy' ? 'reversible' : 'irreversible',
        trigger: { kind: 'manual', detail: action === 'inventory' ? 'Whenever someone wants the list.' : 'Once, in a change window outside any migration wave.', worstCase: 'as often as someone runs it' },
        scope: {
          what: action === 'inventory' ? 'Every HCX instance fleet lifecycle lists. Reads only.' : `The HCX Manager ${hcx}${addAccount ? ', and its account in the HCX management pack' : ''}.`,
          decidedBy: ['The FQDN given, matched exactly against what fleet lifecycle lists.', ...(action === 'upgrade' ? ['The upgrade plan, limited to HCX and that FQDN.'] : [])],
          ifWrong: action === 'upgrade' ? 'An HCX upgrade during a migration wave restarts replication and network extension; running migrations fail.' : 'A second HCX Manager on the network, or one attached to the wrong vCenter.',
        },
        guardrails: [
          { rule: 'Nothing changes without CHANGE set to a change reference', because: 'An HCX upgrade or deployment should be on the change calendar where the migration team sees it.' },
          ...(action === 'upgrade'
            ? [
                { rule: `The upgrade is refused unless the HCX Manager was backed up within ${backupHours} hours and every component in the plan passed the enhanced precheck`, because: 'An HCX upgrade has no rollback other than the backup.' },
              ]
            : []),
          ...(action === 'deploy' ? [{ rule: 'The deployment is refused when the FQDN is already managed or does not resolve; passwords come from mode-600 files and are sent on stdin', because: 'HCX registers by name, and a password in a spec file ends up in the change record.' }] : []),
          { rule: '--dry-run reads and checks and changes nothing', because: 'The plan and the spec are worth reading before HCX restarts.' },
        ],
        dryRun: ['./hcx-lifecycle.sh --dry-run'],
        undo:
          action === 'upgrade'
            ? ['There is no downgrade. Restore the HCX Manager from the fleet lifecycle backup taken before the upgrade.']
            : action === 'deploy'
              ? ['Remove the HCX Manager from Fleet management > Lifecycle > Components, then delete its VM; remove the HCX account under Integrations > Accounts.']
              : ['Nothing to undo.'],
        told: ['Whoever runs it; the task is recorded in Fleet management > Lifecycle > Tasks.'],
        requires: [
          'VCF Operations 9.1 with fleet lifecycle managing the management components.',
          ...(action === 'upgrade' ? [`The HCX ${target} bundle in the depot (Fleet management > Lifecycle > Depot).`] : []),
          ...(action === 'deploy' ? ['Forward and reverse DNS for the HCX Manager, and the HCX bundle in the depot.'] : []),
          ...(addAccount ? ['The HCX management pack installed ("Install or upgrade a management pack") and an HCX credential under Integrations > Credentials (HCX_CREDENTIAL_ID).'] : []),
          'jq and curl.',
        ],
        files: {
          'hcx-lifecycle.sh': script,
          ...(action === 'deploy' ? { 'hcx-deploy.json': `${JSON.stringify(deploySpec, null, 2)}\n` } : {}),
          'IMPORT.md': nothingToImportMd(`HCX lifecycle (${action})`, [
            `hcx-lifecycle.sh: run from a host that reaches VCF Operations and ${lcmHost}, with VCFOPS_HOST and a token (or VCFOPS_PASSWORD_FILE), --dry-run first, then with CHANGE=<ref>.`,
            ...(action === 'deploy' ? ['hcx-deploy.json is the deployment spec; the passwords are added from HCX_ADMIN_PASSWORD_FILE and HCX_ROOT_PASSWORD_FILE at run time. If the API refuses it, the same values go into Fleet management > Lifecycle > Components > HCX > Deploy.'] : []),
            'For a readiness check before a migration wave, use "VCF Operations HCX: migration readiness report".',
          ]),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: HCX Manager lifecycle through VCF Operations fleet lifecycle, and the HCX management pack (password and certificate rotation, log bundles).',
          'Fleet LCM token exchange, /components, /upgrade-plans (?action=precheck with ENHANCED, ?action=apply), /tasks and /sddc-lcms/{id}/backups are the calls "Lifecycle, enhanced precheck, depot and backup" uses.',
          'VERIFY: the componentFqdns scope field, the POST /components deployment body, and the HCXAdapter adapter kind and HCX_HOST identifier on your release.',
        ],
        findings,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// VCF Operations for Networks 9.1
// ---------------------------------------------------------------------------

/** Login plus the /api/ni call helper. */
function niPreamble()           {
  return [
    ...networksPreamble(),
    '',
    '# The token goes to curl from a private header file, never as an argument.',
    ...privateHeader('NI_AUTH', 'Authorization: NetworkInsight', 'VCFNET_TOKEN'),
    'ni() {',
    '  local method="$1" path="$2"; shift 2',
    '  curl -sS -f -X "$method" "https://${VCFNET_HOST}/api/ni${path}" \\',
    '    -H "@${NI_AUTH}" \\',
    '    -H "Accept: application/json" -H "Content-Type: application/json" "$@"',
    '}',
    '# The search bar’s language, as POST /search/ql {query, size}.',
    "ql() { jq -n --arg q \"$1\" --argjson s \"${2:-100}\" '{query: $q, size: $s}' | ni POST /search/ql --data @-; }",
  ];
}

function niScript(purpose        , body                   )         {
  return ['#!/usr/bin/env bash', `# ${purpose}`, '#', '# Reads only.', 'set -euo pipefail', '', ...niPreamble(), '', ...body, ''].join('\n');
}

                      
                        
                      
                          
 

function parseDependencies(text        )                                        {
  const deps               = [];
  const bad           = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(.+?)\s*->\s*(.+?)(?:\s*:\s*(\d+(?:\.\d+)?))?$/.exec(line);
    if (!m) {
      bad.push(line);
      continue;
    }
    deps.push({ from: m[1] .trim(), to: m[2] .trim(), weight: m[3] ? Number(m[3]) : 1 });
  }
  return { deps, bad };
}

function parseSizes(text        )                      {
  const sizes = new Map                ();
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = line.lastIndexOf('=');
    if (at < 0) continue;
    const n = Number(line.slice(at + 1).trim());
    if (Number.isFinite(n) && n >= 0) sizes.set(line.slice(0, at).trim(), n);
  }
  return sizes;
}

                           
                                                                                                              
                                                                                                                 
                                            
                                        
 

/**
 * Flows to groups to waves.
 *
 * Applications that talk above the threshold move together (union-find over
 * the strong edges), because splitting them puts their traffic across the
 * interconnect for the length of the migration. Groups are then packed into
 * waves smallest first — the quick wins in wave 1, as on the Migration page —
 * up to the VM cap. Weaker dependencies that end up split across waves are
 * listed rather than hidden.
 */
export function planWaves(apps                   , deps                       , sizes                             , threshold        , cap        )           {
  const parent = new Map                (apps.map((app) => [app, app]));
  const find = (x        )         => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) ;
    parent.set(x, root);
    return root;
  };
  for (const dep of deps) {
    if (dep.weight >= threshold) {
      const a = find(dep.from);
      const b = find(dep.to);
      if (a !== b) parent.set(a, b);
    }
  }
  const byRoot = new Map                  ();
  for (const app of apps) byRoot.set(find(app), [...(byRoot.get(find(app)) ?? []), app]);
  const vmsOf = (list                   ) => list.reduce((sum, app) => sum + (sizes.get(app) ?? 1), 0);
  const groups = [...byRoot.values()]
    .map((list) => [...list].sort())
    .sort((a, b) => vmsOf(a) - vmsOf(b) || a[0] .localeCompare(b[0] ))
    .map((list, index) => ({ id: index + 1, apps: list, vms: vmsOf(list) }));

  const waves                                                    = [];
  for (const group of groups) {
    const last = waves[waves.length - 1];
    if (last && last.vms + group.vms <= cap) {
      last.groups.push(group.id);
      last.vms += group.vms;
    } else {
      waves.push({ wave: waves.length + 1, groups: [group.id], vms: group.vms });
    }
  }
  const waveOfApp = new Map                ();
  for (const wave of waves) for (const id of wave.groups) for (const app of groups[id - 1] .apps) waveOfApp.set(app, wave.wave);
  const crossWave = deps.filter((dep) => waveOfApp.get(dep.from) !== waveOfApp.get(dep.to));
  return { groups, waves, crossWave, oversized: groups.filter((g) => g.vms > cap).map((g) => g.id) };
}

export const NETWORKS_91                                 = [
  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet91_vpc_planning',
    platform: NETWORKS,
    label: 'Plan VPCs from port groups and flows (9.1)',
    group: 'VCF 9.1 planning',
    description:
      'The groundwork for moving from vSphere port groups to NSX VPCs: for one vCenter and distributed switch, which port groups there are, how many VMs sit on each and who talks to whom — exported to CSV — and a proposed VPC with one subnet per port group, as an NSX Policy API payload skeleton to review. It reads Networks and writes files; it does not touch NSX.',
    inputs: [
      { id: 'vcenter', label: 'vCenter', control: 'text', default: 'vcenter-wld01.example.com' },
      { id: 'vds', label: 'Distributed switch', control: 'text', default: 'wld01-vds01' },
      { id: 'project', label: 'NSX project', control: 'text', default: 'default' },
      { id: 'vpc_name', label: 'Proposed VPC', control: 'text', default: 'orders-vpc' },
      {
        id: 'subnets',
        label: 'Port groups to subnets',
        control: 'textarea',
        default: 'pg-orders-web = 10.20.1.0/24 Public\npg-orders-app = 10.20.2.0/24 Private\npg-orders-db = 10.20.3.0/24 Isolated',
        hint: 'One per line: port group = IPv4 CIDR access-mode (Public, Private, Isolated); VPC subnets are IPv4',
      },
      { id: 'days', label: 'Flows over the last (days)', control: 'number', default: 7, min: 1, max: 30 },
    ],
    automation: (values                 , name        )             => {
      const vcenter = str(values, 'vcenter', '');
      const vds = str(values, 'vds', '');
      const project = str(values, 'project', 'default');
      const vpc = str(values, 'vpc_name', 'vpc');
      const days = num(values, 'days', 7);
      const base = slugOf(name || vpc, 'vpc-plan');
      const vpcId = slugOf(vpc, 'vpc');

      const findings            = [];
      const rows = str(values, 'subnets', '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const m = /^(.+?)\s*=\s*([0-9A-Fa-f.:]+\/\d+)\s*(\w+)?$/.exec(line);
          if (!m || familyOf(m[2] ) === null) {
            findings.push(error('vcfnet91.vpc.bad-line', `"${line}" is not "port group = CIDR mode".`, { source: SRC }));
            return undefined;
          }
          // The proposal is NSX VPC subnets, which this plans as IPv4: an IPv6
          // port group is reported, not turned into a payload NSX would refuse.
          if (familyOf(m[2] ) === 6) {
            findings.push(
              error('vcfnet91.vpc.ipv6', `${m[1] .trim()}: NSX VPC subnets on VCF 9.1 do not support IPv6 (${m[2]}), so it cannot be planned as a VPC subnet here.`, {
                remediation: 'Plan the port group’s IPv4 CIDR, and keep its IPv6 on a segment outside the VPC. VERIFY: IPv6 for VPCs in the NSX release behind your 9.1.x.',
                source: SRC,
              }),
            );
            return undefined;
          }
          return { pg: m[1] .trim(), cidr: m[2] , mode: m[3] ?? 'Private' };
        })
        .filter((row)                                                    => row !== undefined);
      if (rows.length === 0) findings.push(error('vcfnet91.vpc.none', 'No port groups to plan.', { source: SRC }));
      const badMode = rows.filter((row) => !['Public', 'Private', 'Isolated'].includes(row.mode));
      if (badMode.length > 0) findings.push(warning('vcfnet91.vpc.mode', `Unknown access mode on ${badMode.map((r) => r.pg).join(', ')}.`, { remediation: 'Use Public, Private or Isolated; VERIFY the exact enum (for example Private_TGW) in your NSX release.', source: SRC }));
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length; j += 1) {
          if (overlapsAny(rows[i] .cidr, rows[j] .cidr)) findings.push(error('vcfnet91.vpc.overlap', `${rows[i] .cidr} (${rows[i] .pg}) overlaps ${rows[j] .cidr} (${rows[j] .pg}).`, { source: SRC }));
        }
      }
      if (rows.some((row) => row.mode === 'Public')) {
        findings.push(info('vcfnet91.vpc.public', 'Public subnets take addresses from the project’s external IP blocks.', { remediation: 'Check the project has an external block with room before applying.', source: SRC }));
      }

      const csv = [
        ['port_group', 'vlan', 'vm_count', 'proposed_vpc', 'proposed_subnet', 'cidr', 'access_mode', 'talks_to', 'decision', 'notes'].join(','),
        ...rows.map((row) => [row.pg, '', '', vpc, slugOf(row.pg, 'subnet'), row.cidr, row.mode, '', 'review', ''].map(csvCell).join(',')),
      ].join('\n');

      const vpcBody = {
        display_name: vpc,
        description: `Proposed from ${vds} on ${vcenter}. Review before applying.`,
        private_ips: rows.filter((row) => row.mode !== 'Public').map((row) => row.cidr),
      };
      const subnetBodies = Object.fromEntries(
        rows.map((row) => [
          `nsx/subnet-${slugOf(row.pg, 'subnet')}.json`,
          `${JSON.stringify({ display_name: slugOf(row.pg, 'subnet'), ip_addresses: [row.cidr], access_mode: row.mode, _path: `/policy/api/v1/orgs/default/projects/${project}/vpcs/${vpcId}/subnets/${slugOf(row.pg, 'subnet')}` }, null, 2)}\n`,
        ]),
      );

      const pgList = rows.map((row) => `'${sq(row.pg)}'`).join(' ');
      const script = niScript(`Collect the VPC planning facts for ${vds} on ${vcenter} into vpc-planning-observed.csv.`, [
        'OUT=vpc-planning-observed.csv',
        'echo "port_group,vm_count,flows_out,flow_query" > "$OUT"',
        `for PG in ${pgList || "''"}; do`,
        '  [[ -n "$PG" ]] || continue',
        "  VMS=$(ql \"vms where network = '${PG}'\" 1 | jq -r '.entity_list_response.total_count // error(\"no total_count in the search response\")')",
        `  Q="flows where source l2 network = '\${PG}' in last ${days} days"`,
        "  FLOWS=$(ql \"$Q\" 1 | jq -r '.entity_list_response.total_count // error(\"no total_count in the search response\")')",
        '  printf \'%s,%s,%s,"%s"\\n\' "$PG" "$VMS" "$FLOWS" "$Q" >> "$OUT"',
        '  echo "${PG}: ${VMS} VMs, ${FLOWS} flows out"',
        'done',
        'echo "Written to ${OUT}. Merge it into vpc-planning.csv."',
      ]);

      const queries = [
        `# Paste each into the VCF Operations for Networks search bar. VERIFY the property`,
        '# names (network, source l2 network, destination l2 network) in the search bar',
        '# on your release: the suggestions it offers are the authoritative names.',
        '',
        `vms where vcenter manager = '${vcenter}'`,
        `distributed virtual portgroups where distributed virtual switch = '${vds}'`,
        ...rows.flatMap((row) => [
          `vms where network = '${row.pg}'`,
          `flows where source l2 network = '${row.pg}' and destination l2 network != '${row.pg}' in last ${days} days`,
        ]),
        '',
        '# In 9.1, Plan > VPC Planning does this analysis for a chosen vCenter and VDS and',
        '# exports CSV; use that export to check the numbers above.',
        '',
      ].join('\n');

      return {
        platform: NETWORKS,
        title: `VPC plan "${vpc}" from ${rows.length} port group${rows.length === 1 ? '' : 's'} on ${vds}`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Run while planning, and again just before the change to confirm nothing has moved.', worstCase: 'as often as someone runs it' },
        scope: {
          what: `Port groups on ${vds} (${vcenter}), read from Networks. The NSX payloads are files for review; nothing is sent to NSX.`,
          decidedBy: rows.map((row) => `${row.pg} → ${row.cidr} (${row.mode}).`),
          ifWrong: 'A VPC plan that misses a port group or a flow. It is caught at review, not in production, because nothing here applies it.',
        },
        guardrails: [
          { rule: 'Overlapping CIDRs are an error before anything is written', because: 'Two subnets with overlapping ranges in one VPC is rejected by NSX at best and a routing incident at worst.' },
          { rule: 'Nothing is sent to NSX', because: 'A VPC migration moves VMs between networks; that is a change with its own window, not a side effect of planning.' },
        ],
        dryRun: ['Everything here reads. Run collect-vpc-facts.sh and paste search-queries.txt into the search bar.'],
        undo: ['Nothing to undo.'],
        told: ['Whoever reviews vpc-planning.csv.'],
        requires: ['VCF Operations for Networks 9.1 with the vCenter and NSX data sources, and flow collection on the VDS.', 'An NSX project with VPCs enabled, and address blocks for the CIDRs.', 'jq and curl.'],
        files: {
          'vpc-planning.csv': `${csv}\n`,
          'search-queries.txt': queries,
          'collect-vpc-facts.sh': script,
          [`nsx/vpc-${vpcId}.json`]: `${JSON.stringify({ ...vpcBody, _path: `/policy/api/v1/orgs/default/projects/${project}/vpcs/${vpcId}` }, null, 2)}\n`,
          ...subnetBodies,
          'nsx/APPLY.txt': [
            'These are review payloads. Each file names the NSX Policy API path it would be',
            'PATCHed to in _path; remove _path before sending.',
            '',
            'VERIFY against your NSX 9 API reference before use:',
            '  PATCH /policy/api/v1/orgs/default/projects/{project}/vpcs/{vpc}',
            '  PATCH /policy/api/v1/orgs/default/projects/{project}/vpcs/{vpc}/subnets/{subnet}',
            '  - whether private_ips is still set on the VPC or on its connectivity profile;',
            '  - the access_mode enum (Public, Private, Isolated, Private_TGW in recent releases);',
            '  - the connectivity profile attachment, which is not in these payloads.',
            '',
          ].join('\n'),
          [`${base}.txt`]: `VPC ${vpc} in project ${project}, from ${vds} on ${vcenter}.\n`,
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: VPC planning in VCF Operations for Networks gives guidance for moving from vSphere networking to VPCs, after selecting a vCenter and a VDS, with CSV export.',
          'VERIFY: the NSX VPC and subnet field names, and the search-bar property names in the queries.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet91_migration_waves',
    platform: NETWORKS,
    label: 'Generate migration groups and waves from flows (9.1)',
    group: 'VCF 9.1 planning',
    description:
      'Applications that talk to each other move together. From application-to-application flow counts, this groups the chatty ones, packs the groups into waves under a VM cap — smallest first, as the Migration page’s wave 1 — and exports the plan as CSV, plus a portfolio CSV the Migration page imports. A script pulls the flow counts from Networks.',
    inputs: [
      {
        id: 'dependencies',
        label: 'Application flows',
        control: 'textarea',
        default: 'orders-web -> orders-app : 12000\norders-app -> orders-db : 9000\norders-app -> payments : 300\nhr-portal -> hr-db : 4000\nreporting -> orders-db : 40\nwiki -> wiki-db : 800',
        hint: 'One per line: source -> destination : flow count (from collect-app-flows.sh or the 9.1 migration planning export)',
      },
      { id: 'sizes', label: 'VMs per application', control: 'textarea', default: 'orders-web = 6\norders-app = 4\norders-db = 2\npayments = 3\nhr-portal = 2\nhr-db = 1\nreporting = 2\nwiki = 1\nwiki-db = 1', hint: 'app = VM count; an app not listed counts as 1' },
      { id: 'threshold', label: 'Move together above (flows)', control: 'number', default: 500, min: 1, max: 100000000 },
      { id: 'cap', label: 'VMs per wave, at most', control: 'number', default: 15, min: 1, max: 10000 },
      { id: 'days', label: 'Flows over the last (days)', control: 'number', default: 30, min: 1, max: 90 },
    ],
    automation: (values                 , name        )             => {
      const { deps, bad } = parseDependencies(str(values, 'dependencies', ''));
      const sizes = parseSizes(str(values, 'sizes', ''));
      const threshold = num(values, 'threshold', 500);
      const cap = num(values, 'cap', 15);
      const days = num(values, 'days', 30);
      const base = slugOf(name || 'migration-waves', 'migration-waves');
      const apps = [...new Set([...deps.flatMap((d) => [d.from, d.to]), ...sizes.keys()])].sort();
      const plan = planWaves(apps, deps, sizes, threshold, cap);

      const findings            = [];
      for (const line of bad) findings.push(error('vcfnet91.waves.bad-line', `"${line}" is not "source -> destination : count".`, { source: SRC }));
      if (apps.length === 0) findings.push(error('vcfnet91.waves.empty', 'No applications to plan.', { source: SRC }));
      if (plan.oversized.length > 0) {
        findings.push(
          warning('vcfnet91.waves.oversized', `Group${plan.oversized.length === 1 ? '' : 's'} ${plan.oversized.join(', ')} alone exceed${plan.oversized.length === 1 ? 's' : ''} the ${cap}-VM cap and ha${plan.oversized.length === 1 ? 's' : 've'} a wave to itself.`, {
            remediation: 'Either raise the cap for that wave, or raise the threshold so weaker links stop pulling applications together — and accept their traffic crossing the interconnect during the move.',
            source: SRC,
          }),
        );
      }
      if (plan.crossWave.length > 0) {
        findings.push(
          info('vcfnet91.waves.cross', `${plan.crossWave.length} dependenc${plan.crossWave.length === 1 ? 'y crosses' : 'ies cross'} waves: ${plan.crossWave.map((d) => `${d.from} → ${d.to} (${d.weight})`).join('; ')}.`, {
            remediation: 'These flows run over HCX network extension or the WAN between waves. Check latency tolerance for each before committing the plan.',
            source: SRC,
          }),
        );
      }

      const groupOf = new Map                ();
      for (const group of plan.groups) for (const app of group.apps) groupOf.set(app, group.id);
      const waveOfGroup = new Map                ();
      for (const wave of plan.waves) for (const id of wave.groups) waveOfGroup.set(id, wave.wave);

      const wavesCsv = [
        'wave,group,application,vms,depends_on,depended_on_by',
        ...plan.waves.flatMap((wave) =>
          wave.groups.flatMap((id) =>
            plan.groups[id - 1] .apps.map((app) =>
              [
                `Wave ${wave.wave}`,
                `G${id}`,
                app,
                sizes.get(app) ?? 1,
                deps.filter((d) => d.from === app).map((d) => d.to).join(' '),
                deps.filter((d) => d.to === app).map((d) => d.from).join(' '),
              ]
                .map(csvCell)
                .join(','),
            ),
          ),
        ),
      ].join('\n');

      const portfolio = [
        CSV_COLUMNS.join(','),
        ...apps.map((app) =>
          CSV_COLUMNS.map((column) => {
            if (column === 'name') return csvCell(app);
            if (column === 'integrationCount') return String(deps.filter((d) => d.from === app || d.to === app).length);
            if (column === 'notes') return csvCell(`VCF Operations for Networks: group G${groupOf.get(app)}, network wave ${waveOfGroup.get(groupOf.get(app) ?? 0) ?? '?'}`);
            return '';
          }).join(','),
        ),
      ].join('\n');

      const collect = niScript(`Pull application-to-application flow counts over ${days} days into app-flows.txt, in the format this blueprint reads.`, [
        '# Applications as defined in Networks (GET /groups/applications).',
        "APPS=$(ni GET '/groups/applications?size=1000' | jq -r '(.results // error(\"no results in /groups/applications\"))[].entity_id')",
        '[[ -n "$APPS" ]] || { echo "No applications defined in Networks: nothing to measure." >&2; exit 2; }',
        ': > app-flows.txt',
        'for ID in $APPS; do',
        "  SRC=$(ni POST /entities/fetch --data \"$(jq -n --arg id \"$ID\" '{entity_ids: [{entity_type: \"Application\", entity_id: $id}]}')\" | jq -r '.results[0].entity.name // empty')",
        '  [[ -n "$SRC" ]] || continue',
        "  for DST_ID in $APPS; do",
        '    [[ "$DST_ID" == "$ID" ]] && continue',
        "    DST=$(ni POST /entities/fetch --data \"$(jq -n --arg id \"$DST_ID\" '{entity_ids: [{entity_type: \"Application\", entity_id: $id}]}')\" | jq -r '.results[0].entity.name // empty')",
        `    N=$(ql "flows where source application = '\${SRC}' and destination application = '\${DST}' in last ${days} days" 1 | jq -r '.entity_list_response.total_count // error(\"no total_count in the search response\")')`,
        '    (( N > 0 )) && echo "${SRC} -> ${DST} : ${N}" | tee -a app-flows.txt',
        '  done',
        'done',
        'echo "Paste app-flows.txt into the Application flows box."',
      ]);

      return {
        platform: NETWORKS,
        title: `Migration waves — ${plan.groups.length} groups in ${plan.waves.length} waves (≤${cap} VMs each)`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Run while planning; re-run collect-app-flows.sh before each wave, since flows change.', worstCase: 'one search per application pair per run' },
        scope: {
          what: `${apps.length} applications, grouped by flows of ${threshold} or more over ${days} days.`,
          decidedBy: ['The applications defined in Networks, and their names.', `The ${threshold}-flow threshold that decides who moves together.`, `The ${cap}-VM cap per wave.`],
          ifWrong: 'Two applications that talk heavily land in different waves, and their traffic runs over the interconnect for weeks. The cross-wave list is where that shows.',
        },
        guardrails: [
          { rule: 'Every dependency split across waves is listed', because: 'A plan that hides the split is how a database ends up a WAN hop from its application for a month.' },
          { rule: 'Groups larger than the cap are flagged, not split', because: 'Splitting a tightly coupled group to meet a number moves the problem, it does not solve it.' },
        ],
        dryRun: ['It only reads. collect-app-flows.sh makes one search per application pair; on a large estate run it out of hours.'],
        undo: ['Nothing to undo.'],
        told: ['The migration team, through waves.csv; the Migration page, through portfolio-import.csv.'],
        requires: ['Applications defined in VCF Operations for Networks (see "Define an application and its tiers").', 'Flow collection for long enough to cover monthly jobs: 30 days is the minimum worth trusting.', 'jq and curl.'],
        files: {
          'waves.csv': `${wavesCsv}\n`,
          'portfolio-import.csv': `${portfolio}\n`,
          'collect-app-flows.sh': collect,
          [`${base}.json`]: `${JSON.stringify({ threshold, cap, days, groups: plan.groups, waves: plan.waves, crossWave: plan.crossWave }, null, 2)}\n`,
        },
        notes: [
          'portfolio-import.csv has the Migration page’s import columns; the network group and wave are in notes. The Migration page decides its own wave from risk and readiness — the two are complementary: that one says how hard, this one says what must move together.',
          'CONFIRMED in the 9.1 release notes: migration planning in Networks generates waves and groups automatically. Compare its result with this one; where they disagree, the flows threshold is usually why.',
          'VERIFY: GET /groups/applications, POST /entities/fetch and the "source application" / "destination application" search properties against your release.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet91_assessment',
    platform: NETWORKS,
    label: 'Network assessment report, and VKS/Antrea IPFIX checklist (9.1)',
    group: 'VCF 9.1 planning',
    description:
      'The numbers behind a Network Assessment and Value conversation — east-west against north-south, traffic that hairpins through a physical router, flows with no firewall rule, VMs on VLAN-backed port groups — pulled from Networks into a CSV, and the checklist for getting pod-level flows from VKS clusters running Antrea into the same collector.',
    inputs: [
      { id: 'days', label: 'Over the last (days)', control: 'number', default: 7, min: 1, max: 30 },
      { id: 'include_vks', label: 'Include the VKS/Antrea IPFIX checklist', control: 'toggle', default: true },
      { id: 'collector', label: 'Networks collector (IPFIX target)', control: 'text', default: 'vcfnet-collector01.example.com', showWhen: { input: 'include_vks', equals: ['true'] } },
    ],
    automation: (values                 , name        )             => {
      const days = num(values, 'days', 7);
      const vks = bool(values, 'include_vks', true);
      const collector = str(values, 'collector', '');
      const base = slugOf(name || 'network-assessment', 'network-assessment');

      const findings            = [];
      if (days < 7) findings.push(warning('vcfnet91.assess.short', `${days} days misses weekly jobs.`, { remediation: 'Seven days is the shortest window that shows a whole week’s pattern.', source: SRC }));

      const questions                              = [
        ['All flows', `flows in last ${days} days`],
        ['East-west', `flows where Flow Type = 'East-West' in last ${days} days`],
        ['North-south (internet)', `flows where Flow Type = 'Internet' in last ${days} days`],
        ['Routed through a physical router', `flows where Flow Type = 'Routed' and Flow Type = 'Physical' in last ${days} days`],
        ['Same host', `flows where Flow Type = 'Same Host' in last ${days} days`],
        ['No firewall rule seen', `flows where firewall rule is not set in last ${days} days`],
        ['VMs', 'vms'],
        ['VMs on VLAN-backed port groups', "vms where network type = 'VLAN'"],
      ];
      const script = niScript(`Network assessment counts over ${days} days into ${base}.csv.`, [
        `OUT=${base}.csv`,
        'echo "measure,count,query" > "$OUT"',
        'FAILED=0',
        ...questions.flatMap(([label, query]) => [
          `Q='${sq(query)}'`,
          "if N=$(ql \"$Q\" 1 | jq -r '.entity_list_response.total_count // \"?\"'); then :; else N=\"?\"; FAILED=1; fi",
          `printf '%s,%s,"%s"\\n' '${sq(label)}' "$N" "$Q" >> "$OUT"`,
          `echo '${sq(label)}': "$N"`,
        ]),
        'echo "Written to ${OUT}."',
        '(( FAILED )) && echo "Some searches failed: paste them into the search bar to see why (VERIFY the property names)." >&2',
        'exit $FAILED',
      ]);

      const checklist = [
        `VKS clusters with Antrea — IPFIX to VCF Operations for Networks 9.1 (collector ${collector || '<set>'})`,
        '',
        '[ ] Networks 9.1 or later: container IPFIX flows from VKS clusters with Antrea are new in 9.1.',
        '[ ] The VKS cluster uses Antrea as its CNI (the default for VKS).',
        '[ ] Antrea FlowExporter is enabled. On VKS this is set through the AntreaConfig',
        '    object for the cluster, not by editing the antrea-agent ConfigMap directly:',
        '      featureGates: FlowExporter: true',
        `      flowExporter / flowCollectorAddr: "${collector || '<collector>'}:4739:udp"`,
        '    VERIFY the AntreaConfig field names and the collector port for your VKS and',
        '    Antrea versions (4739 is the IPFIX standard port; check what the collector listens on).',
        '[ ] Node and pod CIDRs of the cluster can reach the collector on that port.',
        '[ ] The cluster is added as a data source in Networks (Kubernetes / VKS) so flows',
        '    are attributed to pods and namespaces rather than to node IPs.',
        '[ ] After an hour, search: flows where kubernetes cluster = \'<cluster>\' — non-zero means it works.',
        '',
      ].join('\n');

      return {
        platform: NETWORKS,
        title: `Network assessment — ${days}-day flow profile`,
        effect: 'read',
        trigger: { kind: 'manual', detail: 'Before a VCF networking design discussion, and after a change to measure it.', worstCase: `${questions.length} searches per run` },
        scope: {
          what: 'Counts of flows and VMs from Networks. Reads only.',
          decidedBy: ['The data sources Networks has, and how long it has held flows.', `The ${days}-day window.`],
          ifWrong: 'An assessment built on a partial view: a source not collecting makes east-west look smaller than it is. Check data source health first.',
        },
        guardrails: [
          { rule: 'Every search is a count, not a flow dump', because: 'Pulling every flow for a week is a heavy query on the platform and a large file nobody reads.' },
          { rule: 'A failed search is shown as "?" and the script exits 1', because: 'A zero from a query that did not run would read as "no hairpinned traffic".' },
        ],
        dryRun: ['It only reads. Paste any of the queries in the script into the search bar to see the flows behind a number.'],
        undo: ['Nothing to undo.'],
        told: [`Whoever runs it; ${base}.csv is the output.`],
        requires: ['VCF Operations for Networks with vCenter and NSX data sources collecting.', 'jq and curl.', ...(vks ? ['For the VKS checklist: access to the VKS cluster configuration.'] : [])],
        files: {
          [`${base}.sh`]: script,
          ...(vks ? { 'vks-antrea-ipfix-checklist.txt': checklist } : {}),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: Network Assessment and Value (evaluate the current network and the value of VCF networking) and container IPFIX from VKS clusters with Antrea. The built-in assessment in the interface is the fuller version; this script is the repeatable, versioned subset.',
          'VERIFY: the Flow Type values and the "firewall rule" and "network type" properties in the search bar of your release.',
        ],
        findings,
      };
    },
  }),

  // -------------------------------------------------------------------------
  automationBlueprint({
    id: 'vcfnet91_health',
    platform: NETWORKS,
    label: 'Infrastructure problems report for admins (9.1)',
    group: 'VCF 9.1 operations',
    description:
      'The open problem events Networks has raised about the infrastructure — appliances, NSX, edges, host networking — as a daily report that exits non-zero when anything at or above the chosen severity is open. The 9.1 health dashboards show the same thing to someone looking; this is for when nobody is.',
    inputs: [
      {
        id: 'severity',
        label: 'Report at or above',
        control: 'select',
        options: [
          { value: 'CRITICAL', label: 'Critical' },
          { value: 'MODERATE', label: 'Moderate' },
          { value: 'WARNING', label: 'Warning' },
          { value: 'INFO', label: 'Info' },
        ],
        default: 'MODERATE',
      },
      { id: 'hours', label: 'Raised in the last (hours)', control: 'number', default: 24, min: 1, max: 720 },
      { id: 'schedule', label: 'Emit a crontab line', control: 'toggle', default: true },
    ],
    automation: (values                 , name        )             => {
      const severity = str(values, 'severity', 'MODERATE');
      const hours = num(values, 'hours', 24);
      const schedule = bool(values, 'schedule', true);
      const base = slugOf(name || 'vcfnet-problems', 'vcfnet-problems');
      const order = ['INFO', 'WARNING', 'MODERATE', 'CRITICAL'];
      const include = order.slice(order.indexOf(severity));

      const findings            = [];
      if (severity === 'INFO') findings.push(warning('vcfnet91.health.info', 'Reporting from Info upwards will fail every day.', { remediation: 'A report that always exits 1 is ignored within a week. Start at Moderate.', source: SRC }));

      const script = niScript(`Open infrastructure problems in VCF Operations for Networks, ${severity} and above, raised in the last ${hours} hours. Exits 1 when there are any.`, [
        'NOW=$(date +%s)',
        `START=$(( NOW - ${hours} * 3600 ))`,
        '# Problem events, through the entity search. VERIFY entity_type ProblemEvent and',
        '# the filter property names against your release.',
        'WORK=$(umask 077; mktemp -d "${TMPDIR:-/tmp}/work.XXXXXX")',
        'trap \'rm -rf "$WORK" "${NI_AUTH:-}"\' EXIT',
        '# Every page (the search returns a cursor while there is more), into files:',
        '# the id list of a bad day is over the 128 KB limit on one argument. A',
        '# response without results is an error, not "no problems". VERIFY the cursor',
        '# field on your release.',
        'CURSOR=""',
        ': > "$WORK/ids.items"',
        'for _ in $(seq 1 1000); do',
        `  jq -n --argjson s "$START" --argjson e "$NOW" --arg f "status = 'OPEN'" --arg c "$CURSOR" '{entity_type: "ProblemEvent", filter: $f, size: 1000, time_range: {start_time: $s, end_time: $e}} + (if $c == "" then {} else {cursor: $c} end)' > "$WORK/body.json"`,
        '  ni POST /search --data @"$WORK/body.json" > "$WORK/page.json"',
        '  jq -e \'has("results")\' "$WORK/page.json" >/dev/null || { echo "The search returned no results list — VERIFY the request against your release." >&2; exit 2; }',
        '  jq -c \'.results[] | {entity_type: "ProblemEvent", entity_id}\' "$WORK/page.json" >> "$WORK/ids.items"',
        '  NEXT=$(jq -r \'.cursor // empty\' "$WORK/page.json")',
        '  [[ -n "$NEXT" && "$NEXT" != "$CURSOR" && $(jq \'.results | length\' "$WORK/page.json") -gt 0 ]] || break',
        '  CURSOR="$NEXT"',
        'done',
        'COUNT=$(grep -c . "$WORK/ids.items" || true)',
        'echo "${COUNT} open problem event(s) in the window"',
        '(( COUNT == 0 )) && exit 0',
        '',
        '# Fetch the details, 100 at a time, through files.',
        ': > "$WORK/raw.items"',
        'split -l 100 "$WORK/ids.items" "$WORK/batch."',
        'for b in "$WORK"/batch.*; do',
        '  jq -s \'{entity_ids: .}\' "$b" > "$WORK/fetch.json"',
        '  ni POST /entities/fetch --data @"$WORK/fetch.json" | jq -c \'(.results // error("no results in /entities/fetch"))[]\' >> "$WORK/raw.items"',
        'done',
        `jq -s '{results: .}' "$WORK/raw.items" > ${base}-raw.json`,
        `jq -r --argjson keep '${JSON.stringify(include)}' '`,
        '  [.results[]?.entity | select(((.severity // "") | ascii_upcase) as $s | $keep | index($s))]',
        '  | sort_by(.severity) | .[]',
        '  | "\\(.severity)\\t\\(.name // .problem_type // "?")\\t\\(((.anchor_entities // []) | map(.entity_id) | join(" ")))"',
        `' ${base}-raw.json | tee ${base}.tsv`,
        `N=$(wc -l < ${base}.tsv)`,
        `echo "\${N} at ${severity} or above"`,
        '(( N == 0 )) || exit 1',
      ]);

      return {
        platform: NETWORKS,
        title: `Networks infrastructure problems — ${severity} and above, last ${hours}h`,
        effect: 'read',
        trigger: { kind: 'schedule', detail: `Daily at 06:45, over the last ${hours} hours`, worstCase: 'once a day' },
        scope: {
          what: `Open problem events in VCF Operations for Networks, severity ${include.join(', ')}.`,
          decidedBy: ['What Networks raises as a problem event, which depends on its data sources.', `The severity floor: ${severity}.`, `The ${hours}-hour window.`],
          ifWrong: 'A problem missed because it is older than the window, or a report so noisy it is ignored. Neither changes anything.',
        },
        guardrails: [
          { rule: 'Reads only, and exits 1 only when something at or above the floor is open', because: 'A scheduler alerts on the exit code; one that always fails trains people to ignore it.' },
          { rule: 'The login uses a mode-600 password file, not a token in the crontab, and the token reaches curl from a private header file', because: 'Networks tokens expire, and a password in a crontab or a token on a command line is readable by other users of the host.' },
          { rule: 'Follows the search cursor to the last page, fetches details 100 at a time through files, and stops (exit 2) when a response has no results list', because: 'One unpaged page hides everything after the first thousand, a long id list on the command line fails at 128 KB, and a response in an unexpected shape would otherwise read as "no problems".' },
        ],
        dryRun: ['It only reads. Run it by hand once and compare with the 9.1 health dashboards in the interface.'],
        undo: ['Nothing to undo.'],
        told: [`Whoever reads ${base}.tsv, and whatever alerts on the exit code.`],
        requires: ['A read-only Networks account.', 'jq and curl.'],
        files: {
          [`${base}.sh`]: script,
          ...(schedule ? { 'crontab.txt': `# Daily at 06:45. The password file is mode 600 and owned by the account that runs this.\n45 6 * * * cd /opt/vcf-automation/${base} && ${networksScheduledEnv('svc-vcfnet-readonly')} ./${base}.sh >> /var/log/${base}.log 2>&1\n` } : {}),
        },
        notes: [
          'CONFIRMED in the 9.1 release notes: infrastructure health dashboards that capture critical issues around appliances and capabilities, and NSX health metrics for appliances, edges and host networking.',
          'VERIFY: entity_type ProblemEvent, the status filter, and the severity, name and anchor_entities fields. POST /search and POST /entities/fetch are the long-standing /api/ni calls.',
        ],
        findings,
      };
    },
  }),
];

import io,re,json,os
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from scrub import scrub


tf=json.load(io.open('/tmp/port/tf.json',encoding='utf-8'))
an=json.load(io.open('/tmp/port/an.json',encoding='utf-8'))
tfc=json.load(io.open('/tmp/port/tf_consts.json',encoding='utf-8'))
anc=json.load(io.open('/tmp/port/an_consts.json',encoding='utf-8'))


# Inputs whose answers are a known, closed set, and which the originals left as
# free text. A dropdown here removes a class of plan-time error.
#
# Sizes, shapes, SKUs and engine versions are deliberately NOT converted: those
# lists run to hundreds of values, change between releases, and a dropdown that
# omitted a valid one would be worse than a text box.
INPUT_OVERRIDES = {
    # (platform, blueprint, input id): (import name, list expression)
    ('gcp', 'vpc_network', 'region'): 'GCP_REGIONS.map((r: string) => ({ value: r, label: r }))',
    ('gcp', 'cloud_sql_instance', 'region'): 'GCP_REGIONS.map((r: string) => ({ value: r, label: r }))',
    ('gcp', 'cloud_function', 'location'): 'GCP_REGIONS.map((r: string) => ({ value: r, label: r }))',
    ('gcp', 'cloud_run_service', 'location'): 'GCP_REGIONS.map((r: string) => ({ value: r, label: r }))',
    ('gcp', 'gke_cluster', 'location'): 'GCP_ZONES.map((z: string) => ({ value: z, label: z }))',
    ('gcp', 'gcs_bucket', 'location'): "[{ value: 'US', label: 'US (multi-region)' }, { value: 'EU', label: 'EU (multi-region)' }, { value: 'ASIA', label: 'ASIA (multi-region)' }, ...GCP_REGIONS.map((r: string) => ({ value: r, label: r }))]",
    ('azure', 'azurerm_storage_account_secure', 'account_tier'): "[{ value: 'Standard', label: 'Standard' }, { value: 'Premium', label: 'Premium' }]",
    ('azure', 'azurerm_storage_account_secure', 'replication_type'): "[{ value: 'LRS', label: 'LRS — locally redundant' }, { value: 'ZRS', label: 'ZRS — zone redundant' }, { value: 'GRS', label: 'GRS — geo redundant' }, { value: 'RAGRS', label: 'RAGRS — geo redundant, read access' }, { value: 'GZRS', label: 'GZRS — geo-zone redundant' }, { value: 'RAGZRS', label: 'RAGZRS — geo-zone redundant, read access' }]",
}

def apply_overrides(inputs_src, pid, sid):
    """Turn a declared text input into a select with the real answer set."""
    import re as _re
    out = inputs_src
    for (p, b, iid), options in INPUT_OVERRIDES.items():
        if p != pid or b != sid:
            continue
        # Match the whole `{ id: "x", ... }` object for this input.
        pattern = _re.compile(r'\{[^{}]*\bid:\s*"' + _re.escape(iid) + r'"[^{}]*\}')
        m = pattern.search(out)
        if not m:
            continue
        obj = m.group(0)
        label = _re.search(r'label:\s*"([^"]*)"', obj)
        default = _re.search(r'default:\s*"([^"]*)"', obj)
        hint = _re.search(r'hint:\s*"([^"]*)"', obj)
        parts = ['id: "%s"' % iid,
                 'label: "%s"' % (label.group(1) if label else iid),
                 "control: 'select'",
                 'options: %s' % options]
        if default: parts.append('default: "%s"' % default.group(1))
        if hint: parts.append('hint: "%s"' % hint.group(1))
        out = out[:m.start()] + '{ ' + ', '.join(parts) + ' }' + out[m.end():]
    return out

def fix_body(src):
    """Annotate the one implicit-any the ported templates produce.

    Their templates split a CSV and map over it; under noImplicitAny the
    callback parameter needs a type. Doing it here rather than by hand keeps the
    templates regenerable from the originals.
    """
    return fix_modules(src.replace('.map(s =>', '.map((s: string) =>'))


# Modules that moved or were renamed since the originals were written.
# Every replacement was looked up in the committed Galaxy catalog, so each one
# is a name the installed collection actually has.
MODULE_RENAMES = [
    ('"amazon.aws.dynamodb_table"', '"community.aws.dynamodb_table"'),
    ('"amazon.aws.sqs_queue"', '"community.aws.sqs_queue"'),
    ('"amazon.aws.sns_topic"', '"community.aws.sns_topic"'),
    ('"azure.azcollection.azure_keyvaultsecret"', '"azure.azcollection.azure_rm_keyvaultsecret"'),
    ('"google.cloud.gcp_cloudfunctions_function"', '"google.cloud.gcp_cloudfunctions_cloud_function"'),
    ('"oracle.oci.oci_core_vcn"', '"oracle.oci.oci_network_vcn"'),
    ('"oracle.oci.oci_core_internet_gateway"', '"oracle.oci.oci_network_internet_gateway"'),
    ('"oracle.oci.oci_core_route_table"', '"oracle.oci.oci_network_route_table"'),
    ('"oracle.oci.oci_core_subnet"', '"oracle.oci.oci_network_subnet"'),
    ('"oracle.oci.oci_load_balancer_load_balancer"', '"oracle.oci.oci_loadbalancer_load_balancer"'),
    ('"oracle.oci.oci_load_balancer_backendset"', '"oracle.oci.oci_loadbalancer_backend_set"'),
    ('"oracle.oci.oci_load_balancer_backend"', '"oracle.oci.oci_loadbalancer_backend"'),
    ('"oracle.oci.oci_load_balancer_listener"', '"oracle.oci.oci_loadbalancer_listener"'),
    ('"oracle.oci.oci_containerengine_cluster"', '"oracle.oci.oci_container_engine_cluster"'),
    ('"oracle.oci.oci_kms_key"', '"oracle.oci.oci_key_management_key"'),
    ('"ansible.windows.win_domain_membership"', '"microsoft.ad.membership"'),
]

# amazon.aws.sns_subscription no longer exists; subscriptions are set on the
# topic itself. Fold the second task into the first rather than emitting a
# module that is not there.
SNS_OLD = """                {
                  name: "Create SNS topic",
                  "community.aws.sns_topic": {
                    name: "{{ topic_name }}",
                    region: "{{ aws_region }}"
                  },
                  register: "topic"
                },
                {
                  name: "Subscribe email",
                  "amazon.aws.sns_subscription": {
                    topic_arn: "{{ topic.topic_arn }}",
                    protocol: "email",
                    endpoint: "{{ subscription_email }}"
                  }
                }"""
SNS_NEW = """                {
                  // community.aws.sns_topic carries its own subscriptions; the
                  // separate sns_subscription module no longer exists.
                  name: "Create SNS topic with its subscription",
                  "community.aws.sns_topic": {
                    name: "{{ topic_name }}",
                    region: "{{ aws_region }}",
                    subscriptions: [
                      { endpoint: "{{ subscription_email }}", protocol: "email" }
                    ]
                  },
                  register: "topic"
                }"""

# google.cloud 1.14.0 has no Cloud Run module at all. Emitting one that does not
# exist would be worse than saying so, so this calls the CLI and says why.
# google.cloud 1.14.0 has no Cloud Run module. Emitting one that does not exist
# would produce a playbook that fails on the first task with a message about a
# missing module, so this calls the CLI instead and says why in the play.
RUN_OLD = """                  {
                    name: "Create Cloud Run service",
                    "google.cloud.gcp_run_service": {
                      project: "{{ gcp_project }}",
                      name: "{{ service_name }}",
                      location: "{{ location }}",
                      template: {
                        spec: {
                          containers: [
                            {
                              image: "{{ image }}"
                            }
                          ]
                        }
                      }
                    }
                  },"""
RUN_NEW = """                  {
                    // google.cloud 1.14.0 ships no Cloud Run module, so this
                    // calls the CLI. changed_when is explicit because a deploy
                    // that changes nothing still exits zero.
                    name: "Deploy the Cloud Run service (no module exists in google.cloud)",
                    "ansible.builtin.command": {
                      argv: [
                        "gcloud", "run", "deploy", "{{ service_name }}",
                        "--project", "{{ gcp_project }}",
                        "--region", "{{ location }}",
                        "--image", "{{ image }}",
                        "--platform", "managed",
                        "--quiet"
                      ]
                    },
                    register: "cloud_run_deploy",
                    changed_when: "'Deploying' in cloud_run_deploy.stderr"
                  },
                  {
                    name: "Allow unauthenticated access",
                    "ansible.builtin.command": {
                      argv: [
                        "gcloud", "run", "services", "add-iam-policy-binding", "{{ service_name }}",
                        "--project", "{{ gcp_project }}",
                        "--region", "{{ location }}",
                        "--member", "allUsers",
                        "--role", "roles/run.invoker",
                        "--quiet"
                      ]
                    },
                    when: "allow_unauth | bool",
                    changed_when: true
                  },"""

def fix_modules(src):
    out = src
    for old, new in MODULE_RENAMES:
        out = out.replace(old, new)
    out = out.replace(SNS_OLD, SNS_NEW)
    out = out.replace(RUN_OLD, RUN_NEW)
    return out

def fix_inputs(src):
    """Their inputs use type:"text"/"number"; the new model uses control for all."""
    s=re.sub(r'\btype:\s*"text"', "control: 'text'", src)
    s=re.sub(r'\btype:\s*"number"', "control: 'number'", s)
    s=re.sub(r'\bcontrol:\s*"select"', "control: 'select'", s)
    return s

def split_params(build_src):
    """('(vals, moduleName)', 'body') from the extracted arrow source."""
    depth=0;k=0;instr=None;esc=False
    while k<len(build_src):
        ch=build_src[k]
        if esc: esc=False
        elif ch=='\\': esc=True
        elif instr:
            if ch==instr: instr=None
        elif ch in '"\'`': instr=ch
        elif ch=='(': depth+=1
        elif ch==')':
            depth-=1
            if depth==0: break
        k+=1
    params=build_src[1:k]
    rest=build_src[k+1:]
    arrow=rest.index('=>')
    body=rest[arrow+2:].strip()
    names=[p.strip() for p in params.split(',') if p.strip()]
    return names, body

def esc_ts(s):
    return s.replace('\\','\\\\').replace("'","\\'")

HEADER_TF = '''/**
 * %(label)s Terraform blueprints.
 *
 * Ported from the previous toolkit's TERRA_DEFS — the inputs and the HCL
 * templates are the originals, unchanged. What is new around them: the inputs
 * are typed, so a one-of choice is a dropdown rather than a text box, and every
 * resource type a blueprint emits is checked against the committed provider
 * catalog by the test suite.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import { AWS_REGIONS, AZURE_REGIONS, GCP_REGIONS, GCP_ZONES, OCI_REGIONS } from './regions.ts';

const BLUEPRINTS: readonly Blueprint[] = [
'''

HEADER_AN = '''/**
 * %(label)s Ansible blueprints.
 *
 * Ported from the previous toolkit's SCENARIO_DEFS — the inputs and the play
 * structures are the originals, unchanged. What is new around them: the plays
 * are rendered by this toolkit's own YAML writer, a requirements.yml is derived
 * from the modules each play actually uses, and every module name is checked
 * against the committed Galaxy catalog.
 */

import type { Blueprint, BlueprintGroup, BlueprintValues, TemplateValues } from '../../kit/blueprint.ts';
import { str } from '../../kit/blueprint.ts';
import { playbookFiles } from '../from-plays.ts';
import { AWS_REGIONS, AZURE_LOCATIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from './regions.ts';
import { HOSTS_INPUT } from './common.ts';

const BLUEPRINTS: readonly Blueprint[] = [
'''

TARGET_IDS = {'gcp': 'google', 'vmware': 'vsphere'}

def target_of(pid):
    return TARGET_IDS.get(pid, pid)

def gen_tf(pid, pdef):
    out=[HEADER_TF % {'label': pdef['label']}]
    for sid,s in pdef['scenarios'].items():
        if not (s['inputs'] and s['build']): continue
        names, body = split_params(s['build'])
        vals = names[0] if names else 'vals'
        mod  = names[1] if len(names)>1 else 'moduleName'
        out.append("  {\n")
        out.append("    id: '%s',\n" % sid)
        out.append("    label: '%s',\n" % esc_ts(s['label']))
        out.append("    description: '%s',\n" % esc_ts(s['description']))
        out.append("    inputs: %s,\n" % apply_overrides(fix_inputs(s['inputs']), pid, sid))
        out.append("    emits: [],\n")
        out.append("    build: (values: BlueprintValues, name: string) => ({\n")
        out.append("      files: {\n")
        out.append("        'main.tf': ((%s: TemplateValues, %s: string): string => %s)(values, name),\n" % (vals, mod, fix_body(body)))
        out.append("      },\n")
        out.append("    }),\n")
        out.append("  },\n")
    out.append("];\n\n")
    out.append("export const %s_TERRAFORM: BlueprintGroup = {\n  target: '%s',\n  label: '%s',\n  blueprints: BLUEPRINTS,\n};\n" % (pid.upper(), target_of(pid), esc_ts(pdef['label'])))
    return ''.join(out)

def gen_an(pid, pdef):
    out=[HEADER_AN % {'label': pdef['label']}]
    for sid,s in pdef['scenarios'].items():
        if not (s['inputs'] and s['build']): continue
        names, body = split_params(s['build'])
        vals = names[0] if names else 'vals'
        hosts = names[1] if len(names)>1 else 'hosts'
        inputs = apply_overrides(fix_inputs(s['inputs']), pid, sid)
        # Give every playbook the inventory pattern as a real parameter.
        inputs = '[\n    HOSTS_INPUT,\n' + inputs.lstrip()[1:]
        out.append("  {\n")
        out.append("    id: '%s',\n" % sid)
        out.append("    label: '%s',\n" % esc_ts(s['label']))
        out.append("    description: '%s',\n" % esc_ts(s['description']))
        out.append("    inputs: %s,\n" % inputs)
        out.append("    emits: [],\n")
        out.append("    build: (values: BlueprintValues, name: string) =>\n")
        out.append("      playbookFiles(\n")
        out.append("        ((%s: TemplateValues, %s: string) => %s)(values, str(values, 'hosts', 'all')),\n" % (vals, hosts, fix_body(body)))
        out.append("        name,\n")
        out.append("        '%s',\n" % esc_ts(s['label']))
        out.append("      ),\n")
        out.append("  },\n")
    out.append("];\n\n")
    out.append("export const %s_ANSIBLE: BlueprintGroup = {\n  target: '%s',\n  label: '%s',\n  blueprints: BLUEPRINTS,\n};\n" % (pid.upper(), target_of(pid), esc_ts(pdef['label'])))
    return ''.join(out)

os.makedirs('src/terraform/blueprints', exist_ok=True)
os.makedirs('src/ansible/blueprints', exist_ok=True)

# Region lists are canonical now (src/kit/regions.ts); these are re-export
# shims so the ported templates keep their import names.
io.open('src/terraform/blueprints/regions.ts','w',encoding='utf-8',newline='\n').write(scrub("/**\n * Region and zone lists for the Terraform blueprints.\n *\n * Re-exported from the canonical lists so the two generators cannot drift apart\n * about which regions exist. See src/kit/regions.ts for why that matters.\n */\n\nexport {\n  AWS_REGIONS,\n  AZURE_REGIONS,\n  GCP_REGIONS,\n  GCP_ZONES,\n  OCI_REGIONS,\n} from '../../kit/regions.ts';\n"))
io.open('src/ansible/blueprints/regions.ts','w',encoding='utf-8',newline='\n').write(scrub("/**\n * Region, zone and boolean option lists for the Ansible blueprints.\n *\n * Re-exported from the canonical lists so the two generators cannot drift apart\n * about which regions exist. See src/kit/regions.ts for why that matters.\n *\n * AZURE_LOCATIONS is the same list as AZURE_REGIONS; the previous toolkit used\n * Azure's own word for it here, and the templates still do.\n */\n\nexport { AWS_REGIONS, GCP_REGIONS, GCP_ZONES, BOOL_OPTIONS } from '../../kit/regions.ts';\nexport { AZURE_REGIONS as AZURE_LOCATIONS, OCI_REGIONS } from '../../kit/regions.ts';\n"))

for pid,pdef in tf.items():
    io.open('src/terraform/blueprints/%s.ts'%pid,'w',encoding='utf-8',newline='\n').write(scrub(gen_tf(pid,pdef)))
for pid,pdef in an.items():
    io.open('src/ansible/blueprints/%s.ts'%pid,'w',encoding='utf-8',newline='\n').write(scrub(gen_an(pid,pdef)))
print('terraform:', sorted(tf.keys()))
print('ansible:', sorted(an.keys()))

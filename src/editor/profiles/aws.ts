/**
 * AWS: CloudFormation templates (JSON or YAML, SAM included) and IAM policy
 * documents.
 *
 * CloudFormation checks are the ones the service applies before it creates
 * anything: the sections and resource attributes it knows, a resource type
 * in the AWS::Service::Resource shape, and every Ref, GetAtt, Sub, DependsOn
 * and Condition pointing at something the template declares. Each resource's
 * Properties are checked against the CloudFormation registry's schema for its
 * type (./cloudformation-schema.ts): unknown and read-only properties, missing
 * required ones, primitive types and enumerations, into nested definitions
 * and lists. A value that is an intrinsic function is never judged. IAM checks are
 * the policy grammar: Version, Effect, Action/NotAction, Resource/NotResource,
 * and the condition operators. Policies inside a template are checked too.
 */

import { error, info, warning, type Finding } from '../../core/findings.ts';
import { pathString, type Json, type Path } from '../doc.ts';
import { asList, didYouMean, isObj, keysOf, last, str, type Profile } from '../profile.ts';
import { cfnServiceTypes, cfnTypes, cfnTypeSchema, isKnownCfnType, loadCfnType, CFN_SCHEMA_SOURCE, type CfnBlock, type CfnSpec, type CfnTypeSchema } from '../cloudformation-schema.ts';

const CFN_SOURCE = 'AWS CloudFormation template reference (docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-anatomy.html)';
const IAM_SOURCE = 'IAM JSON policy element reference (docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements.html)';

const SECTIONS = new Set(['AWSTemplateFormatVersion', 'Description', 'Metadata', 'Parameters', 'Rules', 'Mappings', 'Conditions', 'Transform', 'Resources', 'Outputs']);
const RESOURCE_ATTRIBUTES = new Set(['Type', 'Properties', 'DependsOn', 'Condition', 'Metadata', 'DeletionPolicy', 'UpdateReplacePolicy', 'UpdatePolicy', 'CreationPolicy']);
const PARAMETER_KEYS = new Set(['Type', 'Default', 'AllowedValues', 'AllowedPattern', 'ConstraintDescription', 'Description', 'MaxLength', 'MinLength', 'MaxValue', 'MinValue', 'NoEcho']);
const PSEUDO = new Set(['AWS::AccountId', 'AWS::NotificationARNs', 'AWS::NoValue', 'AWS::Partition', 'AWS::Region', 'AWS::StackId', 'AWS::StackName', 'AWS::URLSuffix']);

export const PARAMETER_TYPES = [
  'String', 'Number', 'List<Number>', 'CommaDelimitedList',
  'AWS::EC2::AvailabilityZone::Name', 'AWS::EC2::Image::Id', 'AWS::EC2::Instance::Id', 'AWS::EC2::KeyPair::KeyName',
  'AWS::EC2::SecurityGroup::GroupName', 'AWS::EC2::SecurityGroup::Id', 'AWS::EC2::Subnet::Id', 'AWS::EC2::Volume::Id',
  'AWS::EC2::VPC::Id', 'AWS::Route53::HostedZone::Id',
  'List<AWS::EC2::AvailabilityZone::Name>', 'List<AWS::EC2::Image::Id>', 'List<AWS::EC2::Instance::Id>',
  'List<AWS::EC2::SecurityGroup::GroupName>', 'List<AWS::EC2::SecurityGroup::Id>', 'List<AWS::EC2::Subnet::Id>',
  'List<AWS::EC2::Volume::Id>', 'List<AWS::EC2::VPC::Id>', 'List<AWS::Route53::HostedZone::Id>',
  'AWS::SSM::Parameter::Name', 'AWS::SSM::Parameter::Value<String>', 'AWS::SSM::Parameter::Value<List<String>>',
  'AWS::SSM::Parameter::Value<CommaDelimitedList>', 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
];

// ---------------------------------------------------------------------------
// IAM policy documents
// ---------------------------------------------------------------------------

const CONDITION_BASE = new Set([
  'StringEquals', 'StringNotEquals', 'StringEqualsIgnoreCase', 'StringNotEqualsIgnoreCase', 'StringLike', 'StringNotLike',
  'NumericEquals', 'NumericNotEquals', 'NumericLessThan', 'NumericLessThanEquals', 'NumericGreaterThan', 'NumericGreaterThanEquals',
  'DateEquals', 'DateNotEquals', 'DateLessThan', 'DateLessThanEquals', 'DateGreaterThan', 'DateGreaterThanEquals',
  'Bool', 'BinaryEquals', 'IpAddress', 'NotIpAddress', 'ArnEquals', 'ArnLike', 'ArnNotEquals', 'ArnNotLike', 'Null',
]);

export function isConditionOperator(op: string): boolean {
  const m = /^(ForAllValues:|ForAnyValue:)?([A-Za-z]+?)(IfExists)?$/.exec(op);
  if (!m) return false;
  const base = m[2] as string;
  if (!CONDITION_BASE.has(base)) return false;
  return !(base === 'Null' && m[3]);
}

const STATEMENT_KEYS = new Set(['Sid', 'Effect', 'Principal', 'NotPrincipal', 'Action', 'NotAction', 'Resource', 'NotResource', 'Condition']);

function isPolicy(doc: Json): doc is Record<string, Json> {
  return isObj(doc) && 'Statement' in doc && (Array.isArray(doc.Statement) || isObj(doc.Statement));
}

/** Findings for one IAM policy document at `at`. */
export function checkIamPolicy(doc: Record<string, Json>, at: (string | number)[], out: Finding[]): void {
  const p = (...rest: (string | number)[]) => pathString([...at, ...rest]);
  const version = str(doc.Version);
  if (version === undefined) {
    out.push(warning('iam.version.missing', 'No Version, so IAM reads the policy with the 2008 rules: policy variables such as ${aws:username} are taken literally.', { path: p(), remediation: 'Add "Version": "2012-10-17".', source: IAM_SOURCE }));
  } else if (version === '2008-10-17') {
    out.push(warning('iam.version.old', 'Version 2008-10-17 does not support policy variables.', { path: p('Version'), remediation: 'Use 2012-10-17.', source: IAM_SOURCE }));
  } else if (version !== '2012-10-17') {
    out.push(error('iam.version.invalid', `${version} is not a policy language version; IAM accepts 2012-10-17 and 2008-10-17.`, { path: p('Version'), source: IAM_SOURCE }));
  }
  const statements = Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
  const sids = new Set<string>();
  statements.forEach((s, i) => {
    const sp = (...rest: (string | number)[]) => (Array.isArray(doc.Statement) ? p('Statement', i, ...rest) : p('Statement', ...rest));
    if (!isObj(s)) {
      out.push(error('iam.statement.shape', 'A statement must be an object.', { path: sp() }));
      return;
    }
    for (const key of Object.keys(s)) {
      if (!STATEMENT_KEYS.has(key)) {
        const guess = didYouMean(key, STATEMENT_KEYS);
        out.push(error('iam.statement.key', `${key} is not a statement element.${guess ? ` Did you mean ${guess}?` : ''}`, { path: sp(key), source: IAM_SOURCE }));
      }
    }
    const sid = str(s.Sid);
    if (sid !== undefined) {
      if (sids.has(sid)) out.push(error('iam.sid.duplicate', `Sid ${sid} is used twice in this policy.`, { path: sp('Sid'), source: IAM_SOURCE }));
      sids.add(sid);
      if (!/^[A-Za-z0-9]*$/.test(sid)) out.push(warning('iam.sid.chars', 'IAM identity policies allow only letters and digits in a Sid.', { path: sp('Sid'), source: IAM_SOURCE }));
    }
    if (s.Effect !== 'Allow' && s.Effect !== 'Deny') {
      out.push(error('iam.effect', 'Effect must be Allow or Deny.', { path: sp('Effect'), source: IAM_SOURCE }));
    }
    const hasAction = 'Action' in s;
    const hasNotAction = 'NotAction' in s;
    if (hasAction === hasNotAction) out.push(error('iam.action', 'A statement needs exactly one of Action and NotAction.', { path: sp(), source: IAM_SOURCE }));
    const actionKey = hasAction ? 'Action' : 'NotAction';
    asList(s[actionKey]).forEach((a, ai) => {
      const text = str(a);
      if (text !== '*' && !(text && /^[a-z0-9-]+:[A-Za-z0-9*?]+$/.test(text))) {
        out.push(error('iam.action.format', `“${String(a)}” is not an action; actions are written service:Action, as s3:GetObject.`, { path: Array.isArray(s[actionKey]) ? sp(actionKey, ai) : sp(actionKey), source: IAM_SOURCE }));
      }
    });
    const hasResource = 'Resource' in s || 'NotResource' in s;
    const hasPrincipal = 'Principal' in s || 'NotPrincipal' in s;
    if ('Resource' in s && 'NotResource' in s) out.push(error('iam.resource.both', 'A statement takes Resource or NotResource, not both.', { path: sp(), source: IAM_SOURCE }));
    if (!hasResource && !hasPrincipal) {
      out.push(error('iam.resource.missing', 'An identity policy statement needs a Resource (or NotResource).', { path: sp(), source: IAM_SOURCE }));
    }
    asList(s.Resource ?? s.NotResource).forEach((r, ri) => {
      const text = str(r);
      const key = 'Resource' in s ? 'Resource' : 'NotResource';
      if (text !== undefined && text !== '*' && !text.startsWith('arn:') && !text.includes('${')) {
        out.push(error('iam.resource.format', `“${text}” is not an ARN or *.`, { path: Array.isArray(s[key]) ? sp(key, ri) : sp(key), source: IAM_SOURCE }));
      }
    });
    if (isObj(s.Condition)) {
      for (const op of Object.keys(s.Condition)) {
        if (!isConditionOperator(op)) {
          const guess = didYouMean(op, CONDITION_BASE);
          out.push(error('iam.condition.operator', `${op} is not a condition operator.${guess ? ` Did you mean ${guess}?` : ''}`, { path: sp('Condition', op), source: IAM_SOURCE }));
        }
      }
    }
    const all = (v: Json | undefined) => asList(v).includes('*');
    if (s.Effect === 'Allow' && all(s.Action) && all(s.Resource) && !s.Condition) {
      out.push(warning('iam.full-admin', 'Allow * on * with no condition is full administrator access.', { path: sp(), remediation: 'Name the actions and resources this role needs.' }));
    }
    const principal = s.Principal;
    if (s.Effect === 'Allow' && (principal === '*' || (isObj(principal) && asList(principal.AWS).includes('*'))) && !s.Condition) {
      out.push(warning('iam.public', 'Allow to Principal * with no condition opens this to anyone, including anonymous callers.', { path: sp('Principal') }));
    }
  });
}

export const awsIamPolicy: Profile = {
  id: 'aws-iam-policy',
  family: 'aws',
  label: 'AWS IAM policy',
  format: 'json',
  source: IAM_SOURCE,
  detect: (doc) => (isPolicy(doc) ? (str(doc.Version)?.match(/^20(12|08)-10-17$/) ? 0.95 : 0.6) : 0),
  choices(path: Path) {
    const key = last(path);
    if (key === 'Version' && path.length === 1) return ['2012-10-17', '2008-10-17'];
    if (key === 'Effect') return ['Allow', 'Deny'];
    return undefined;
  },
  validate(doc) {
    const out: Finding[] = [];
    if (isPolicy(doc)) checkIamPolicy(doc, [], out);
    return out;
  },
  itemTitle: (value) => (isObj(value) ? str(value.Sid) ?? (str(value.Effect) ? `${value.Effect} ${asList(value.Action ?? value.NotAction).slice(0, 2).join(', ')}` : undefined) : undefined),
};

// ---------------------------------------------------------------------------
// CloudFormation
// ---------------------------------------------------------------------------

function isTemplate(doc: Json): doc is Record<string, Json> {
  if (!isObj(doc)) return false;
  if ('AWSTemplateFormatVersion' in doc) return true;
  const r = doc.Resources;
  return isObj(r) && Object.values(r).some((v) => isObj(v) && typeof v.Type === 'string' && /^(AWS|Custom|Alexa)::/.test(v.Type));
}

/** Names a `Fn::Sub` string refers to: `${Name}` and `${Resource.Attr}`, not `${!Literal}`. */
export function subReferences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\$\{([^}!][^}]*)\}/g)) out.push((m[1] as string).trim());
  return out;
}

// --- resource properties against the registry schemas ----------------------

/** `{Ref: x}`, `{Condition: x}` or `{"Fn::…": …}`: a value decided at deploy time. */
export function isIntrinsic(value: Json | undefined): boolean {
  if (!isObj(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0] === 'Condition' || (keys[0] as string).startsWith('Fn::'));
}

/** A dynamic reference (`{{resolve:ssm:…}}`) or an interpolation: not a literal to judge. */
function isDynamicString(value: Json | undefined): boolean {
  return typeof value === 'string' && (value.includes('{{resolve:') || value.includes('${'));
}

const specCode = (spec: CfnSpec): string => (typeof spec === 'string' ? spec : spec[0]);
const specEnum = (spec: CfnSpec): readonly string[] | undefined => (typeof spec === 'string' ? undefined : spec[1]);

const TYPE_NAMES: Readonly<Record<string, string>> = { s: 'a string', n: 'a number', i: 'an integer', b: 'a boolean (true or false)' };

function describeCode(code: string): string {
  if (code.startsWith('a:')) return 'a list';
  if (code.startsWith('o:')) return 'an object';
  return TYPE_NAMES[code] ?? 'a value';
}

interface CfnCheck {
  readonly type: string;
  readonly schema: CfnTypeSchema;
  readonly out: Finding[];
}

/** Findings for an object `value` shaped by `block`, at `at`. */
function checkCfnBlock(c: CfnCheck, block: CfnBlock, value: Json, at: (string | number)[], top: boolean): void {
  if (value === null || isIntrinsic(value)) return;
  if (!isObj(value)) {
    c.out.push(error('cfn.property.type', `${top ? 'Properties' : String(last(at))} must be an object for ${c.type}.`, { path: pathString(at), source: CFN_SCHEMA_SOURCE }));
    return;
  }
  const names = Object.keys(block.p);
  const readOnly = top ? new Set(c.schema.ro ?? []) : new Set<string>();
  for (const [key, v] of Object.entries(value)) {
    const here = [...at, key];
    const spec = block.p[key];
    if (spec === undefined) {
      const guess = didYouMean(key, names);
      const where = top ? c.type : `${String(last(at))} (${c.type})`;
      const message = `${key} is not a property of ${where}.${guess ? ` Did you mean ${guess}?` : ''}`;
      const opts = { path: pathString(here), source: CFN_SCHEMA_SOURCE };
      c.out.push(block.o ? warning('cfn.property.unknown', message, opts) : error('cfn.property.unknown', message, opts));
      continue;
    }
    if (readOnly.has(key)) {
      c.out.push(error('cfn.property.read-only', `${key} is read-only on ${c.type}: CloudFormation returns it (Fn::GetAtt), a template cannot set it.`, { path: pathString(here), source: CFN_SCHEMA_SOURCE }));
      continue;
    }
    checkCfnValue(c, spec, v, here);
  }
  for (const r of block.r ?? []) {
    if (!(r in value)) {
      c.out.push(error('cfn.property.required', `${c.type}${top ? '' : ` ${String(last(at))}`} needs ${r}.`, { path: pathString(at), source: CFN_SCHEMA_SOURCE }));
    }
  }
}

/** Findings for one property value against its spec. */
function checkCfnValue(c: CfnCheck, spec: CfnSpec, value: Json, at: (string | number)[]): void {
  if (value === null || isIntrinsic(value) || isDynamicString(value)) return;
  const code = specCode(spec);
  const name = String(keysOf(at).slice(-1)[0] ?? '');
  const wrong = () =>
    c.out.push(error('cfn.property.type', `${name} on ${c.type} takes ${describeCode(code)}, not ${Array.isArray(value) ? 'a list' : isObj(value) ? 'an object' : JSON.stringify(value)}.`, { path: pathString(at), source: CFN_SCHEMA_SOURCE }));
  if (code === 'j') return;
  if (code.startsWith('a:')) {
    if (!Array.isArray(value)) return wrong();
    const item: CfnSpec = specEnum(spec) ? [code.slice(2), specEnum(spec) as readonly string[]] : code.slice(2);
    value.forEach((v, i) => checkCfnValue(c, item, v, [...at, i]));
    return;
  }
  if (code.startsWith('o:')) {
    const def = c.schema.d?.[code.slice(2)];
    if (!isObj(value)) return wrong();
    if (def) checkCfnBlock(c, def, value, at, false);
    return;
  }
  if (Array.isArray(value) || isObj(value)) return wrong();
  if (code === 'b' && !(typeof value === 'boolean' || (typeof value === 'string' && /^(true|false)$/i.test(value)))) return wrong();
  if ((code === 'n' || code === 'i') && typeof value !== 'number' && !(typeof value === 'string' && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(value))) return wrong();
  if (code === 'i' && !Number.isInteger(Number(value))) return wrong();
  const allowed = specEnum(spec);
  if (allowed && !allowed.includes(String(value))) {
    const guess = didYouMean(String(value), allowed);
    const list = allowed.length <= 12 ? `: ${allowed.join(', ')}` : '';
    c.out.push(error('cfn.property.enum', `${String(value)} is not an allowed value of ${name} on ${c.type}${list}.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString(at), source: CFN_SCHEMA_SOURCE }));
  }
}

/** Findings for one resource's type and Properties against the registry schema. */
function checkCfnResource(res: Record<string, Json>, type: string, at: (string | number)[], out: Finding[]): void {
  if (type.startsWith('Custom::')) {
    out.push(info('cfn.resource.custom', `${type} is a custom resource; its properties go to your provider and are not checked here.`, { path: pathString([...at, 'Type']) }));
    return;
  }
  if (type.startsWith('AWS::Serverless::')) {
    out.push(info('cfn.resource.sam', `${type} is a SAM resource, expanded by the AWS::Serverless transform; its properties are not checked here.`, { path: pathString([...at, 'Type']) }));
    return;
  }
  if (!/^(AWS|Alexa)::/.test(type)) return; // a private registry type or module: its schema is the publisher's
  if (!isKnownCfnType(type)) {
    const guess = didYouMean(type, cfnTypes());
    out.push(error('cfn.resource.type-unknown', `${type} is not a CloudFormation resource type.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString([...at, 'Type']), source: CFN_SCHEMA_SOURCE }));
    return;
  }
  const schema = cfnTypeSchema(type);
  if (!schema) return; // not fetched yet: prepare() brings it, and the page checks again
  const props = res.Properties;
  if (props === undefined) {
    if (schema.r?.length) out.push(error('cfn.property.required', `${type} needs ${schema.r.join(', ')}.`, { path: pathString(at), source: CFN_SCHEMA_SOURCE }));
    return;
  }
  checkCfnBlock({ type, schema, out }, schema, props, [...at, 'Properties'], true);
}

/** The enum for the property at `rest` (the path under Properties), when it has one. */
function cfnChoices(schema: CfnTypeSchema, rest: Path): readonly string[] | undefined {
  let block: CfnBlock | undefined = schema;
  let spec: CfnSpec | undefined;
  for (const step of rest) {
    if (typeof step === 'number') {
      if (!spec || !specCode(spec).startsWith('a:')) return undefined;
      const e = specEnum(spec);
      spec = e ? [specCode(spec).slice(2), e] : specCode(spec).slice(2);
    } else {
      if (spec !== undefined) {
        const code = specCode(spec);
        block = code.startsWith('o:') ? schema.d?.[code.slice(2)] : undefined;
      }
      spec = block?.p[step];
      if (!spec) return undefined;
    }
  }
  return spec && !specCode(spec).startsWith('a:') ? specEnum(spec) : undefined;
}

function templateTypes(doc: Json): string[] {
  if (!isObj(doc) || !isObj(doc.Resources)) return [];
  return [...new Set(Object.values(doc.Resources).flatMap((r) => (isObj(r) && typeof r.Type === 'string' ? [r.Type] : [])))];
}

export const awsCloudFormation: Profile = {
  id: 'aws-cloudformation',
  family: 'aws',
  label: 'AWS CloudFormation template',
  format: 'yaml',
  source: CFN_SOURCE,
  detect: (doc) => (isTemplate(doc) ? 0.95 : 0),
  prepare: (doc) => Promise.all(templateTypes(doc).map(loadCfnType)).then(() => undefined),
  choices(path: Path, doc: Json) {
    const keys = keysOf(path);
    const key = last(path);
    if (keys.length === 1 && key === 'AWSTemplateFormatVersion') return ['2010-09-09'];
    if (keys[0] === 'Parameters' && keys.length === 3 && key === 'Type') return PARAMETER_TYPES;
    if (keys[0] === 'Parameters' && keys.length === 3 && key === 'Default' && isObj(doc) && isObj(doc.Parameters)) {
      const param = doc.Parameters[keys[1] as string];
      if (isObj(param) && Array.isArray(param.AllowedValues)) return param.AllowedValues.map(String);
    }
    if (keys[0] === 'Resources' && keys.length === 3 && key === 'DeletionPolicy') return ['Delete', 'Retain', 'RetainExceptOnCreate', 'Snapshot'];
    if (keys[0] === 'Resources' && keys.length === 3 && key === 'UpdateReplacePolicy') return ['Delete', 'Retain', 'Snapshot'];
    // Resource types: the ones in the same service as the current type (the full list is ~1,800).
    if (path[0] === 'Resources' && path.length === 3 && key === 'Type' && isObj(doc) && isObj(doc.Resources)) {
      const res = doc.Resources[path[1] as string];
      const type = isObj(res) ? str(res.Type) : undefined;
      const same = type ? cfnServiceTypes(type) : undefined;
      if (same) return same;
    }
    // A resource property's enumeration, from the registry schema.
    if (path[0] === 'Resources' && path[2] === 'Properties' && path.length > 3 && isObj(doc) && isObj(doc.Resources)) {
      const res = doc.Resources[path[1] as string];
      const type = isObj(res) ? str(res.Type) : undefined;
      const schema = type && isKnownCfnType(type) ? cfnTypeSchema(type) : undefined;
      const found = schema ? cfnChoices(schema, path.slice(3)) : undefined;
      if (found) return found;
    }
    if (key === 'Effect') return ['Allow', 'Deny'];
    if (key === 'Version' && keys.includes('PolicyDocument')) return ['2012-10-17', '2008-10-17'];
    return undefined;
  },
  validate(doc) {
    const out: Finding[] = [];
    if (!isObj(doc)) return out;
    for (const key of Object.keys(doc)) {
      if (!SECTIONS.has(key)) {
        const guess = didYouMean(key, SECTIONS);
        out.push(error('cfn.section', `${key} is not a template section.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString([key]), source: CFN_SOURCE }));
      }
    }
    if ('AWSTemplateFormatVersion' in doc && doc.AWSTemplateFormatVersion !== '2010-09-09') {
      out.push(error('cfn.version', 'AWSTemplateFormatVersion must be 2010-09-09, the only version there is.', { path: 'AWSTemplateFormatVersion', source: CFN_SOURCE }));
    }
    const resources = isObj(doc.Resources) ? doc.Resources : undefined;
    if (!resources || Object.keys(resources).length === 0) {
      out.push(error('cfn.resources', 'A template needs at least one resource.', { path: 'Resources', source: CFN_SOURCE }));
    }
    const params = isObj(doc.Parameters) ? doc.Parameters : {};
    const conditions = isObj(doc.Conditions) ? doc.Conditions : {};
    const mappings = isObj(doc.Mappings) ? doc.Mappings : {};
    const names = new Set([...Object.keys(params), ...Object.keys(resources ?? {})]);
    const logical = /^[A-Za-z0-9]+$/;

    for (const [name, param] of Object.entries(params)) {
      if (!logical.test(name)) out.push(error('cfn.logical-id', `Parameter name ${name} must be letters and digits only.`, { path: pathString(['Parameters', name]), source: CFN_SOURCE }));
      if (!isObj(param)) continue;
      if (!str(param.Type)) out.push(error('cfn.parameter.type', `Parameter ${name} has no Type.`, { path: pathString(['Parameters', name]), source: CFN_SOURCE }));
      for (const k of Object.keys(param)) {
        if (!PARAMETER_KEYS.has(k)) out.push(error('cfn.parameter.key', `${k} is not a parameter property.`, { path: pathString(['Parameters', name, k]), source: CFN_SOURCE }));
      }
      if (/password|secret|token/i.test(name) && param.NoEcho !== true && param.NoEcho !== 'true') {
        out.push(warning('cfn.parameter.noecho', `Parameter ${name} looks like a secret but is not NoEcho, so the console and API show its value.`, { path: pathString(['Parameters', name]), remediation: 'Add NoEcho: true, or better, resolve it from Secrets Manager with {{resolve:secretsmanager:…}}.' }));
      }
      if (/password|secret|token/i.test(name) && typeof param.Default === 'string' && param.Default !== '') {
        out.push(error('cfn.parameter.secret-default', `Parameter ${name} has a secret as its Default, written into the template.`, { path: pathString(['Parameters', name, 'Default']) }));
      }
      if (Array.isArray(param.AllowedValues) && param.Default !== undefined && !param.AllowedValues.map(String).includes(String(param.Default))) {
        out.push(error('cfn.parameter.default', `The Default for ${name} is not one of its AllowedValues.`, { path: pathString(['Parameters', name, 'Default']), source: CFN_SOURCE }));
      }
    }

    for (const [name, res] of Object.entries(resources ?? {})) {
      const at = ['Resources', name];
      if (!logical.test(name)) out.push(error('cfn.logical-id', `Logical ID ${name} must be letters and digits only.`, { path: pathString(at), source: CFN_SOURCE }));
      if (!isObj(res)) {
        out.push(error('cfn.resource.shape', `Resource ${name} must be an object.`, { path: pathString(at) }));
        continue;
      }
      const type = str(res.Type);
      if (!type) out.push(error('cfn.resource.type', `Resource ${name} has no Type.`, { path: pathString(at), source: CFN_SOURCE }));
      else if (!/^(AWS|Alexa)::[A-Za-z0-9]+::[A-Za-z0-9]+(::[A-Za-z0-9]+)?$/.test(type) && !/^Custom::[A-Za-z0-9_@-]+$/.test(type) && !/^[A-Za-z0-9]+::[A-Za-z0-9]+::[A-Za-z0-9]+(::MODULE)?$/.test(type)) {
        out.push(error('cfn.resource.type-format', `${type} is not a resource type; types are written Service::Group::Resource, as AWS::S3::Bucket.`, { path: pathString([...at, 'Type']), source: CFN_SOURCE }));
      }
      for (const k of Object.keys(res)) {
        if (!RESOURCE_ATTRIBUTES.has(k)) {
          const guess = didYouMean(k, RESOURCE_ATTRIBUTES);
          out.push(error('cfn.resource.attribute', `${k} is not a resource attribute.${guess ? ` Did you mean ${guess}?` : ' Properties go under Properties.'}`, { path: pathString([...at, k]), source: CFN_SOURCE }));
        }
      }
      asList(res.DependsOn).forEach((d, di) => {
        if (typeof d === 'string' && !(resources && d in resources)) {
          out.push(error('cfn.dependson', `DependsOn names ${d}, which is not a resource in this template.`, { path: pathString(Array.isArray(res.DependsOn) ? [...at, 'DependsOn', di] : [...at, 'DependsOn']), source: CFN_SOURCE }));
        }
      });
      const cond = str(res.Condition);
      if (cond && !(cond in conditions)) out.push(error('cfn.condition', `Condition ${cond} is not declared under Conditions.`, { path: pathString([...at, 'Condition']), source: CFN_SOURCE }));
      if (type && /^[A-Za-z0-9]+::[A-Za-z0-9_@-]+(::[A-Za-z0-9]+){0,2}$/.test(type)) checkCfnResource(res, type, at, out);
    }

    // Every intrinsic function reference in the template.
    const walk = (node: Json, path: (string | number)[]): void => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, [...path, i]));
        return;
      }
      if (!isObj(node)) return;
      if (path.length > 0 && isPolicy(node) && keysOf(path).some((k) => /Policy|Document/.test(k))) checkIamPolicy(node, path, out);
      const keys = Object.keys(node);
      if (keys.length === 1) {
        const fn = keys[0] as string;
        const arg = node[fn] as Json;
        const here = pathString([...path, fn]);
        if (fn === 'Ref' && typeof arg === 'string' && !names.has(arg) && !PSEUDO.has(arg)) {
          const guess = didYouMean(arg, names);
          out.push(error('cfn.ref', `Ref ${arg} names no parameter or resource in this template.${guess ? ` Did you mean ${guess}?` : ''}`, { path: here, source: CFN_SOURCE }));
        }
        if (fn === 'Fn::GetAtt') {
          const target = Array.isArray(arg) ? str(arg[0]) : str(arg)?.split('.')[0];
          if (target && !(resources && target in resources)) {
            out.push(error('cfn.getatt', `GetAtt names ${target}, which is not a resource in this template.`, { path: here, source: CFN_SOURCE }));
          }
        }
        if (fn === 'Fn::Sub') {
          const text = Array.isArray(arg) ? str(arg[0]) : str(arg);
          const vars = Array.isArray(arg) && isObj(arg[1]) ? arg[1] : {};
          for (const ref of text ? subReferences(text) : []) {
            const base = ref.split('.')[0] as string;
            if (ref in vars || base in vars || PSEUDO.has(ref) || names.has(base)) continue;
            out.push(error('cfn.sub', `Sub refers to \${${ref}}, which is not a parameter, resource or Sub variable.`, { path: here, source: CFN_SOURCE }));
          }
        }
        if (fn === 'Fn::If' && Array.isArray(arg) && typeof arg[0] === 'string' && !(arg[0] in conditions)) {
          out.push(error('cfn.if', `Fn::If uses condition ${arg[0]}, which is not declared.`, { path: here, source: CFN_SOURCE }));
        }
        if (fn === 'Fn::FindInMap' && Array.isArray(arg) && typeof arg[0] === 'string' && !(arg[0] in mappings)) {
          out.push(error('cfn.findinmap', `FindInMap uses mapping ${arg[0]}, which is not declared.`, { path: here, source: CFN_SOURCE }));
        }
        if (fn === 'Condition' && typeof arg === 'string' && path.length > 0 && keysOf(path)[0] === 'Conditions' && !(arg in conditions)) {
          out.push(error('cfn.condition', `Condition ${arg} is not declared.`, { path: here, source: CFN_SOURCE }));
        }
      }
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
    };
    walk(doc, []);

    if (isObj(doc.Outputs)) {
      for (const [name, o] of Object.entries(doc.Outputs)) {
        if (isObj(o) && !('Value' in o)) out.push(error('cfn.output.value', `Output ${name} has no Value.`, { path: pathString(['Outputs', name]), source: CFN_SOURCE }));
      }
    }
    const count = Object.keys(resources ?? {}).length;
    if (count > 500) out.push(error('cfn.limit.resources', `${count} resources; a template takes at most 500.`, { path: 'Resources', source: 'CloudFormation quotas' }));
    if (asList(doc.Transform).some((t) => typeof t === 'string' && t.startsWith('AWS::Serverless'))) {
      out.push(info('cfn.sam', 'This is a SAM template; AWS::Serverless resources are expanded by the transform at deploy time.', { path: 'Transform' }));
    }
    return out;
  },
  itemTitle: (value) => (isObj(value) ? str(value.Sid) ?? str(value.Key) ?? str(value.Name) : undefined),
};

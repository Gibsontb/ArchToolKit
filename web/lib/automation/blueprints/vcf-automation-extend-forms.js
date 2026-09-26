/**
 * VCF Automation custom forms: the request form of a catalog item.
 *
 * A cloud template's inputs are what the deployment needs; the custom form is
 * what the requester sees — which fields, on which page, in what order, what a
 * dropdown offers (a fixed list, or an Orchestrator action asked each time the
 * form opens), and which fields only appear once another has a value. The form
 * is a JSON document (layout and schema) stored by the form service against
 * its source: a cloud template, or an Orchestrator workflow in the catalog.
 *
 * The field table here is also what the custom day-2 action's form is built
 * from, so both write the same shape.
 */

import { str,                      } from '../../kit/blueprint.js';
import { error, info, warning,              } from '../../core/findings.js';
import { automationBlueprint } from '../from-automation.js';
import { slugOf,                 } from '../automation.js';
import { applyScript } from '../apply.js';
import { apiStep, importMd, manualStep } from '../vcfa-import.js';
import { packageNameOf, toPackage } from '../vro/to-package.js';
import { PLATFORM, SRC, VCFA_LOGIN, VERIFY_LOGIN, PKG_REQUIRES, elementName, guardSettings, json, lookupActions, packageSteps, q, rowsOf, underScripts, vcfaActions, vcfaSettings, yes } from './vcf-automation-extend-core.js';

// ---------------------------------------------------------------------------
// The field table

/** The columns of the field table, as the page's grid names them. */
export const FORM_FIELD_HINT = 'Field id | Label | Type | Required | Default | Values | Visible when | Page';

/** type column → schema dataType and the display the form designer gives it. VERIFY the display names against a form exported from your release. */
export const FORM_FIELD_TYPES                                                                                                        = {
  string: { dataType: 'string', display: 'textField', yamlType: 'string' },
  text: { dataType: 'string', display: 'textArea', yamlType: 'string' },
  integer: { dataType: 'integer', display: 'integerField', yamlType: 'integer' },
  decimal: { dataType: 'decimal', display: 'decimalField', yamlType: 'number' },
  boolean: { dataType: 'boolean', display: 'checkbox', yamlType: 'boolean' },
  date: { dataType: 'dateTime', display: 'datetime', yamlType: 'string' },
  secret: { dataType: 'secureString', display: 'passwordField', yamlType: 'string' },
  multi: { dataType: 'string', display: 'multiSelect', multiple: true, yamlType: 'array' },
};

                            
                      
                         
                        
                             
                                
                                                                                                     
                                                                                                                                                                                                                              
                                                                          
                                                                                                      
                        
 

/**
 * The field table, read and checked. Values: "a, b, c" is a fixed list;
 * "action:module/name" asks an Orchestrator action, and
 * "action:module/name(param=field, …)" passes other fields' values to it.
 * Visible when: "field=value" or "field!=value".
 */
export function parseFormFields(text        )                                               {
  const findings            = [];
  const fields              = [];
  for (const [id = '', label = '', typeCell = '', requiredCell = '', defaultValue = '', valuesCell = '', visibleCell = '', pageCell = ''] of rowsOf(text, 8)) {
    const type = (typeCell || 'string').toLowerCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) {
      findings.push(error('vcfa.form.bad-id', `Field id "${id}" is not a name a template input can have (letters, digits, underscore; not starting with a digit).`, { source: SRC }));
      continue;
    }
    if (!FORM_FIELD_TYPES[type]) {
      findings.push(error('vcfa.form.bad-type', `Field ${id}: "${typeCell}" is not one of ${Object.keys(FORM_FIELD_TYPES).join(', ')}.`, { source: SRC }));
      continue;
    }
    let values                      = { kind: 'none' };
    const action = /^action:\s*([A-Za-z0-9_.]+)\/([A-Za-z0-9_]+)\s*(?:\((.*)\))?$/.exec(valuesCell);
    if (action) {
      const bindings = (action[3] ?? '')
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const [param = '', field = ''] = pair.split('=').map((part) => part.trim());
          return [param, field || param]         ;
        });
      values = { kind: 'action', action: `${action[1]}/${action[2]}`, bindings };
      if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(action[1] )) {
        findings.push(warning('vcfa.form.action-module', `Field ${id}: "${action[1]}" is not a reverse-DNS module name, so the action is hard to find and export.`, { source: SRC }));
      }
    } else if (/^action:/i.test(valuesCell)) {
      findings.push(error('vcfa.form.bad-action', `Field ${id}: "${valuesCell}" is not action:module/name or action:module/name(param=field).`, { source: SRC }));
    } else if (valuesCell) {
      values = { kind: 'list', items: valuesCell.split(',').map((v) => v.trim()).filter(Boolean) };
    }
    let visibleWhen                          ;
    if (visibleCell) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(!=|=)\s*(.*)$/.exec(visibleCell);
      if (!m) findings.push(error('vcfa.form.bad-condition', `Field ${id}: "${visibleCell}" is not field=value or field!=value.`, { source: SRC }));
      else visibleWhen = { field: m[1] , equals: m[2] === '=', value: m[3] .trim() };
    }
    fields.push({ id, label: label || id, type, required: yes(requiredCell), defaultValue, values, ...(visibleWhen ? { visibleWhen } : {}), page: pageCell || 'General' });
  }

  const ids = fields.map((f) => f.id);
  for (const dup of ids.filter((id, index) => ids.indexOf(id) !== index)) findings.push(error('vcfa.form.duplicate', `Field ${dup} is in the table twice.`, { source: SRC }));
  for (const field of fields) {
    if (field.visibleWhen && !ids.includes(field.visibleWhen.field)) {
      findings.push(error('vcfa.form.unknown-condition-field', `Field ${field.id} is shown when ${field.visibleWhen.field} has a value, but there is no field ${field.visibleWhen.field}.`, { source: SRC }));
    }
    if (field.visibleWhen && field.required && !field.defaultValue) {
      findings.push(
        warning('vcfa.form.hidden-required', `Field ${field.id} is required but can be hidden, with no default.`, {
          remediation: 'A hidden required field with no value blocks the request with an error the requester cannot see the cause of. Give it a default, or make it optional.',
          source: SRC,
        }),
      );
    }
    if (field.values.kind === 'action') {
      for (const [, bound] of field.values.bindings) if (!ids.includes(bound)) findings.push(error('vcfa.form.unknown-binding', `Field ${field.id} passes ${bound} to its action, but there is no field ${bound}.`, { source: SRC }));
    }
    if (field.type === 'secret' && field.defaultValue) {
      findings.push(error('vcfa.form.secret-default', `Field ${field.id} is a secret with a default, which would store the value in the form for everyone.`, { remediation: 'Leave the default of a secret field empty.', source: SRC }));
    }
    if (field.values.kind === 'list' && field.defaultValue && field.type !== 'multi' && !field.values.items.includes(field.defaultValue)) {
      findings.push(warning('vcfa.form.default-not-offered', `Field ${field.id} defaults to "${field.defaultValue}", which is not one of its values.`, { source: SRC }));
    }
    if (field.type === 'boolean' && field.values.kind !== 'none') {
      findings.push(info('vcfa.form.boolean-values', `Field ${field.id} is a checkbox; its values are ignored.`, { source: SRC }));
    }
  }
  return { fields, findings };
}

const typedDefault = (field           )          => {
  if (field.type === 'boolean') return yes(field.defaultValue);
  if (field.type === 'integer' || field.type === 'decimal') return Number(field.defaultValue);
  if (field.type === 'multi') return field.defaultValue.split(',').map((v) => v.trim()).filter(Boolean);
  return field.defaultValue;
};

/**
 * The form document: layout (pages, sections, fields with display and
 * visibility) and schema (label, type, default, value source, constraints),
 * as the form service stores it in its `form` string. The visibility rule and
 * the action parameter binding follow forms exported from 8.x releases;
 * VERIFY both against a form exported from your release.
 */
export function formDefinition(fields                      )                                                       {
  const pages = [...new Set(fields.map((f) => f.page))];
  const layout = {
    pages: pages.map((title, index) => ({
      id: `page_${slugOf(title, `page${index + 1}`).replace(/-/g, '_')}`,
      title,
      sections: fields
        .filter((f) => f.page === title)
        .map((f, n) => ({
          id: `section_${index + 1}_${n + 1}`,
          fields: [
            {
              id: f.id,
              display: f.values.kind !== 'none' && f.type !== 'multi' && f.type !== 'boolean' ? 'dropDown' : FORM_FIELD_TYPES[f.type] .display,
              ...(f.visibleWhen
                ? { state: { visible: [{ [f.visibleWhen.equals ? 'equals' : 'notEquals']: { [f.visibleWhen.field]: f.visibleWhen.value }, value: true }, { value: false }], 'read-only': false } }
                : {}),
            },
          ],
        })),
    })),
  };
  const schema                          = {};
  for (const f of fields) {
    const type = FORM_FIELD_TYPES[f.type] ;
    schema[f.id] = {
      label: f.label,
      type: { dataType: type.dataType, isMultiple: type.multiple === true },
      ...(f.defaultValue && f.type !== 'secret' ? { default: typedDefault(f) } : {}),
      ...(f.values.kind === 'list' && f.type !== 'boolean' ? { valueList: f.values.items.map((v) => ({ label: v, value: v })) } : {}),
      ...(f.values.kind === 'action'
        ? { valueList: { id: f.values.action, type: 'scriptAction', parameters: f.values.bindings.map(([param, field]) => ({ [param]: field })) } }
        : {}),
      constraints: { required: f.required },
    };
  }
  return { layout, schema };
}

/** The template inputs the form's fields fill: the fields a template has to declare for the form to set them. */
export function templateInputs(fields                      )         {
  return [
    '# The inputs block the template needs for this form: a form field sets the',
    '# template input with the same id. Fields with no input of that id are',
    '# form-only (they feed conditions and actions, and reach nothing else).',
    'inputs:',
    ...fields.flatMap((f) => {
      const type = FORM_FIELD_TYPES[f.type] ;
      return [
        `  ${f.id}:`,
        `    type: ${type.yamlType}`,
        ...(type.yamlType === 'array' ? ['    items:', '      type: string'] : []),
        `    title: ${JSON.stringify(f.label)}`,
        ...(f.type === 'secret' ? ['    encrypted: true'] : []),
        ...(f.values.kind === 'list' && type.yamlType === 'string' ? [`    enum: [${f.values.items.map((v) => JSON.stringify(v)).join(', ')}]`] : []),
        ...(f.defaultValue && f.type !== 'secret' ? [`    default: ${JSON.stringify(typedDefault(f))}`] : []),
      ];
    }),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The blueprint

const DEFAULT_FIELDS = [
  'hostname | Host name | string | yes | - | - | - | General',
  'size | Size | string | yes | small | small, medium, large | - | General',
  'environment | Environment | string | yes | dev | dev, test, prod | - | General',
  'backup | Back it up | boolean | no | true | - | - | Options',
  'backupJob | Backup job | string | no | - | action:com.company.infra/listBackupJobs(environment) | backup=true | Options',
].join('\n');

const SOURCE_TYPES                                                                                = {
  template: { label: 'A cloud template (its catalog item)', sourceType: 'com.vmw.blueprint', what: 'cloud template' },
  workflow: { label: 'An Orchestrator workflow in the catalog', sourceType: 'com.vmw.vro.workflow', what: 'Orchestrator workflow' },
};

export const CUSTOM_FORM = automationBlueprint({
  id: 'vcfa_custom_form',
  platform: PLATFORM,
  label: 'A custom request form for a catalog item',
  group: 'Catalog',
  description:
    'The request form of a catalog item, designed as a table: fields with their type, default and whether they are required, dropdowns from a fixed list or from an Orchestrator action asked each time the form opens (with other fields passed to it), fields that only appear when another has a value, and pages. Applied, enabled, to the cloud template or catalog workflow it belongs to.',
  inputs: [
    {
      id: 'source',
      label: 'Form for',
      control: 'select',
      options: Object.entries(SOURCE_TYPES).map(([value, s]) => ({ value, label: s.label })),
      default: 'template',
    },
    { id: 'source_name', label: 'Template or workflow name', control: 'text', default: 'Linux server', hint: 'Exactly as VCF Automation lists it' },
    { id: 'project', label: 'Project of the template', control: 'text', default: 'Application Team A', showWhen: { input: 'source', equals: ['template'] } },
    { id: 'fields', label: 'Fields', control: 'textarea', default: DEFAULT_FIELDS, hint: FORM_FIELD_HINT },
  ],
  automation: (values                 , name        )             => {
    const sourceKey = str(values, 'source', 'template');
    const source = SOURCE_TYPES[sourceKey] ?? SOURCE_TYPES['template'] ;
    const sourceName = str(values, 'source_name', '');
    const project = str(values, 'project', '');
    const base = slugOf(name || `${sourceName}-form`, 'custom-form');
    const { fields, findings } = parseFormFields(str(values, 'fields', ''));

    if (!sourceName) findings.push(error('vcfa.form.no-source', `No ${source.what} is named, so the form belongs to nothing.`, { source: SRC }));
    if (sourceKey === 'template' && !project) findings.push(error('vcfa.form.no-project', 'Templates are found by name within a project, and no project is set.', { source: SRC }));
    if (fields.length === 0) findings.push(error('vcfa.form.no-fields', 'The form has no fields.', { source: SRC }));
    const actions = [...new Set(fields.flatMap((f) => (f.values.kind === 'action' ? [f.values.action] : [])))];

    const definition = formDefinition(fields);
    const formBody = {
      name: `${sourceName || 'Catalog item'} — request form`,
      type: 'requestForm',
      sourceType: source.sourceType,
      sourceId: `<REQUIRED — the ${source.what} id>`,
      status: 'ON',
      formFormat: 'JSON',
      form: JSON.stringify(definition),
      styles: '',
    };

    const packageName = packageNameOf('vcfa', 'form', base);
    const workflowName = elementName(`Apply form ${sourceName || base}`);
    const pkg = toPackage({
      packageName,
      description: `The custom request form of the ${source.what} "${sourceName}", applied through the form service.`,
      categoryPath: `Automation/Forms/${base}`,
      workflow: {
        name: workflowName,
        description: `Finds the ${source.what} "${sourceName}"${sourceKey === 'template' ? ' in the project' : ''}, then creates its request form, enabled, or replaces a form that differs. The same form is left as it is. Set the dryRun input to true to preview without changing anything.`,
        inputs: [{ name: 'dryRun', type: 'boolean', description: 'true: report what would change and change nothing' }],
        outputs: [
          { name: 'formId', type: 'string', description: 'The form id, empty in a dry run that would create it' },
          { name: 'summary', type: 'string', description: 'The audit record, JSON' },
        ],
        script: [
          `var SOURCE = ${q(sourceKey)};`,
          `var SOURCE_TYPE = ${q(source.sourceType)};`,
          'var ctx = core.begin(settings, dryRun);',
          VCFA_LOGIN,
          String.raw`if (!settings.sourceName) throw new Error("Set sourceName in the configuration element: the template or workflow the form belongs to.");
var sourceId = "";
if (SOURCE === "template") {
  var projectId = mod.projectIdOf(host, auth, SAFE, settings.projectName);
  var template = mod.findOne(mod.listAll(host, auth, "/blueprint/api/blueprints", SAFE), { name: String(settings.sourceName), projectId: projectId }, "template named " + settings.sourceName);
  if (!template) throw new Error("No template named '" + settings.sourceName + "' in project " + settings.projectName + ".");
  sourceId = String(template.id);
} else {
  sourceId = mod.workflowIdByName(settings.vroHost || host, auth, SAFE, String(settings.sourceName));
}
var body = JSON.parse(core.resource(RESOURCE_PATH, "form.json"));
body.sourceId = sourceId;
var found = core.http("GET", "https://" + host + "/form-service/api/forms/search?sourceType=" + encodeURIComponent(SOURCE_TYPE) + "&sourceId=" + encodeURIComponent(sourceId) + "&formType=requestForm", auth, null, { redact: settings._secrets, allow: [404] });
var existing = found.statusCode === 200 && found.body && found.body.id ? found.body : null;
var formId = "";
if (existing && String(existing.form) === String(body.form) && String(existing.status) === "ON") {
  System.log("Exists with the same form, left as it is: request form of " + settings.sourceName + " (" + existing.id + ")");
  formId = String(existing.id);
} else {
  if (existing) body.id = existing.id;
  formId = core.act(ctx, (existing ? "replace" : "create") + " the request form of " + settings.sourceName + ", enabled", function () {
    var r = core.http("POST", "https://" + host + "/form-service/api/forms", auth, body, SAFE);
    return r.body && r.body.id ? String(r.body.id) : String(body.id || "");
  }) || "";
}
formId = ctx.dryRun && !existing ? "" : formId;
summary = core.audit(ctx, { formId: formId, sourceId: sourceId });
core.notify(settings.webhook, summary);`,
        ].join('\n'),
      },
      actions: [...vcfaActions(packageName), ...lookupActions(packageName)],
      config: {
        name: 'Settings',
        description: `Settings of the ${workflowName} workflow. Fill vcfaApiToken after import; set dryRun to true to preview instead of changing anything.`,
        attributes: [
          ...vcfaSettings('vm-apps'),
          { name: 'sourceName', type: 'string', value: sourceName, description: `The ${source.what} the form belongs to, exactly as listed` },
          ...(sourceKey === 'template' ? [{ name: 'projectName', type: 'string'         , value: project, description: 'The project of the template' }] : [{ name: 'vroHost', type: 'string'         , value: '', description: 'The Orchestrator host, when it is not the VCF Automation host' }]),
          ...guardSettings(1, 'changed'),
        ],
      },
      resources: [{ name: 'form.json', content: json(formBody) }],
    });

    return {
      platform: PLATFORM,
      title: `The request form of ${sourceName || '(no source)'} — ${fields.length} field(s) on ${new Set(fields.map((f) => f.page)).size} page(s)`,
      effect: 'reversible',
      trigger: { kind: 'request', detail: `Anybody opening the catalog item for ${sourceName || 'the source'}; the form is evaluated each time it opens`, worstCase: `every form open — and ${actions.length} Orchestrator action(s) asked each time${actions.length > 0 ? ', and again when a field they depend on changes' : ''}` },
      scope: {
        what: `The request form of the ${source.what} ${sourceName || '(none)'}${sourceKey === 'template' ? ` in project ${project || '(none)'}` : ''}.`,
        decidedBy: [
          `The ${source.what} it is attached to, found by name.`,
          'Who the catalog item is shared with — everybody who can request it sees this form.',
          ...(actions.length > 0 ? [`The Orchestrator action${actions.length > 1 ? 's' : ''} ${actions.join(', ')}, which run with Orchestrator’s own credentials whatever the requester may see.`] : []),
        ],
        ifWrong: 'Requesters see the wrong choices, or a required field they cannot fill; requests fail or carry values nobody meant to offer.',
      },
      guardrails: [
        { rule: 'An identical form is left as it is', because: 'Re-applying the same form is a no-op, so the workflow is safe to run from a pipeline.' },
        { rule: 'Field ids, types, conditions and bindings are checked before anything is written', because: 'A condition on a field that does not exist hides a field for ever, silently.' },
        { rule: 'The form service keeps the previous form until this one replaces it', because: 'A failed apply leaves the old form working rather than none.' },
      ],
      dryRun: [
        `Run the package workflow ${workflowName} with the dryRun input set to true: it finds the ${source.what}, reads its current form, logs "DRY RUN: would create …" or "replace …" and changes nothing.`,
        'Open the catalog item after applying and request it once in a test project.',
      ],
      undo: ['Design → Custom Forms on the item: switch the form off (the template inputs are used again), or DELETE /form-service/api/forms/{id}. The previous form is not kept; export it first (GET /form-service/api/forms/search) if you may want it back.'],
      told: ['Nobody: forms are not versioned or audited separately. The request history shows the values each requester chose.'],
      requires: [
        PKG_REQUIRES,
        `The ${source.what} ${sourceName || '(set one)'}${sourceKey === 'template' ? ` in project ${project || '(set one)'}, with an input of the same id for every field that should reach it (see ${base}-template-inputs.yaml)` : ' added to the catalog through a content source'}.`,
        ...(actions.length > 0 ? [`The Orchestrator action${actions.length > 1 ? 's' : ''} ${actions.join(', ')} (see "An Orchestrator action behind a form dropdown").`] : []),
      ],
      files: {
        ...pkg.files,
        [`${base}-form.json`]: json(formBody),
        [`${base}-form-definition.json`]: json(definition),
        [`${base}-template-inputs.yaml`]: templateInputs(fields),
        'scripts/apply.sh': underScripts(applyScript('vcf-automation', [{ method: 'POST', path: '/form-service/api/forms', payload: `${base}-form.json` }], 'DELETE /form-service/api/forms/{id}, or switch the form off on the item (Design → Custom Forms).')),
        'IMPORT.md': importMd({
          subject: `The request form of the ${source.what} "${sourceName}". The Orchestrator package (\`${pkg.packageDir}\`) applies it: its workflow **${workflowName}** finds the ${source.what} by name and creates or replaces its form, enabled. \`scripts/apply.sh\` sends the same JSON by hand once sourceId is filled.`,
          steps: [
            ...packageSteps(pkg),
            ...(sourceKey === 'template' ? [manualStep('Give the template the inputs', [`\`${base}-template-inputs.yaml\` is the inputs block the fields set. Merge it into the template (the "custom resource" and "cloud template" blueprints import templates) and version it, so every field that should reach the deployment has an input of the same id.`])] : []),
            apiStep('Or by hand: the form', 'scripts/apply.sh', [`\`${base}-form.json\` → POST /form-service/api/forms`], [`Fill sourceId first: ${sourceKey === 'template' ? 'GET /blueprint/api/blueprints and take the id of the template' : 'the workflow id from the Orchestrator client'}. In the interface: Design → Custom Forms, or the catalog item → Customize form; paste the layout from \`${base}-form-definition.json\` with Import (VERIFY the menu on 9.1).`]),
          ],
          auth: ['apply'],
          verify: [
            'The form service API (/form-service/api/forms, and /forms/search by sourceType, sourceId and formType) follows the 8.x form service API that VM Apps organizations keep; VERIFY on 9.1, and whether an All Apps organization has custom forms at all — its catalog is documented in the interface only.',
            `sourceType ${source.sourceType} for a ${source.what}, the display names (${[...new Set(fields.map((f) => FORM_FIELD_TYPES[f.type] .display))].join(', ')}), the visible condition (state.visible with equals / notEquals) and the action parameter binding are as forms exported from earlier releases show them; VERIFY by exporting one form made in the designer and comparing.`,
            VERIFY_LOGIN,
          ],
        }),
      },
      notes: [
        'A form field sets the template input with the same id. A field with no such input only exists on the form — useful for a condition or an action parameter, useless for the deployment.',
        'An action behind a dropdown runs every time the form opens and again when a field it is passed changes. Keep it fast, and never let it throw: an exception is an empty dropdown with no reason.',
        'Form constraints (required, the values offered) are checked in the browser only. A request through the API does not go through the form, so the template and the workflows check again.',
      ],
      findings,
    };
  },
});

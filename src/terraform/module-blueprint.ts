/**
 * Turning a registry module into something with a form in front of it.
 *
 * A module blueprint is a short declaration — which module, and which of its
 * inputs to put on the page — and this turns that into an ordinary Blueprint,
 * so the module generators and the resource generators are the same page and
 * the same code path.
 *
 * Only some inputs go on the form, and that is the point rather than a
 * shortcut. `terraform-aws-modules/vpc/aws` takes 236 of them; a form with 236
 * fields is not a better answer than a text box, it is a worse one. The dozen
 * listed per blueprint are the ones a call actually sets, and everything else
 * keeps the module's own default — which is what calling a module is for.
 *
 * Every input named here is checked against the catalog at test time, so a
 * blueprint that names an input a module dropped in a major version fails in
 * the suite rather than at plan.
 */

import type { Blueprint, BlueprintInput, BuildResult } from '../kit/blueprint.ts';
import {
  moduleBySource,
  moduleCall,
  versionConstraint,
  type InputKind,
  type ModuleInput,
} from './modules.ts';
import { planModule } from './module-plan.ts';
import { providerFor, type CloudTarget } from './providers.ts';

/** One field on the form, naming an input the module really has. */
export interface ModuleField {
  /** The module's own input name — also the field id, so the answer-set rules
   *  in kit/choices.ts recognise `instance_type` and friends for free. */
  readonly input: string;
  /** Overrides the input name when it reads badly as a label. */
  readonly label?: string;
  readonly hint?: string;
  readonly default?: string;
  /** Force a control; otherwise it follows the variable's declared shape. */
  readonly control?: BlueprintInput['control'];
  readonly options?: BlueprintInput['options'];
}

export interface ModuleBlueprintSpec {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Registry source, e.g. "terraform-aws-modules/vpc/aws". */
  readonly source: string;
  /** The label in the generated `module "…"` block. */
  readonly name: string;
  readonly fields: readonly ModuleField[];
  /** Which module input takes the tags, when it is not called `tags`. */
  readonly tagsInput?: string;
  /** Outputs worth writing out, so the next stack can consume them. */
  readonly outputs?: readonly string[];
  /** The heading this sits under in the picker. */
  readonly group?: string;
}

/** A variable's shape decides the control when the spec does not. */
function controlFor(kind: InputKind): BlueprintInput['control'] {
  if (kind === 'bool') return 'select';
  if (kind === 'number') return 'number';
  return 'text';
}

function hintFor(kind: InputKind, required: boolean): string | undefined {
  const shape =
    kind === 'list' || kind === 'set' || kind === 'tuple'
      ? 'Comma-separated'
      : kind === 'map' || kind === 'object'
        ? 'key=value, comma-separated'
        : undefined;
  if (required && shape) return `Required. ${shape}`;
  if (required) return 'Required by the module';
  return shape;
}

const BOOL_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

/** `private_subnet_names` to "Private subnet names". */
function labelFor(input: string): string {
  const words = input.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What an empty box stands for: the module's default, as the module writes it. */
function placeholderFor(input: ModuleInput): string | undefined {
  const d = input.defaultExpr;
  if (d === '' || d === 'null') {
    return input.kind === 'list' || input.kind === 'map' || input.kind === 'object' || input.kind === 'set'
      ? input.type
      : undefined;
  }
  return d.startsWith('"') && d.endsWith('"') ? d.slice(1, -1) : d;
}

/** `bool · default null`, the two columns of the registry table that fit in a hint. */
function typeHint(input: ModuleInput): string {
  const type = input.type.includes('\n') || input.type.length > 32 ? input.kind : input.type;
  const d = input.defaultExpr;
  if (input.required) return `${type} · required`;
  const shown = d.includes('\n') || d.length > 28 ? 'see box' : d || 'none';
  return `${type} · default ${shown}`;
}

/** One input from the full table, as a form field that starts empty. */
function everyInput(input: ModuleInput, section: string | undefined): BlueprintInput {
  const control: BlueprintInput['control'] =
    input.kind === 'bool'
      ? 'select'
      : input.kind === 'number'
        ? 'number'
        : input.kind === 'string'
          ? 'text'
          : 'textarea';
  return {
    id: input.name,
    // The module's own name, as the registry page and the module's README
    // print it — these are looked up, not read like a form.
    label: input.name,
    control,
    hint: typeHint(input),
    help: input.description || undefined,
    placeholder: placeholderFor(input),
    options: control === 'select' ? BOOL_OPTIONS : undefined,
    blankLabel: input.required
      ? undefined
      : `Module default (${input.defaultExpr === '' ? 'none' : input.defaultExpr})`,
    section,
  };
}

export function moduleBlueprint(target: CloudTarget, spec: ModuleBlueprintSpec): Blueprint {
  const module = moduleBySource(spec.source);
  if (!module) {
    throw new Error(`No catalog entry for module ${spec.source}`);
  }

  const headline: BlueprintInput[] = spec.fields.map((field) => {
    const declared = module.inputs.find((i) => i.name === field.input);
    if (!declared) {
      throw new Error(`Module ${spec.source} has no input "${field.input}"`);
    }
    const control = field.control ?? controlFor(declared.kind);
    return {
      id: field.input,
      label: field.label ?? labelFor(field.input),
      control,
      hint: field.hint ?? hintFor(declared.kind, declared.required),
      help: declared.description || undefined,
      placeholder: placeholderFor(declared),
      default: field.default,
      options: field.options ?? (control === 'select' && declared.kind === 'bool' ? BOOL_OPTIONS : undefined),
    };
  });

  /*
   * Then every other input the module takes — the registry page's whole table.
   *
   * A required one the spec did not list goes up top with the headline
   * questions, since a call without it does not plan. The rest sit in a
   * collapsed section in the module's own order, each with its description,
   * its type and its default, and each empty until touched: empty means the
   * module's default, and only what is touched is written into the call.
   */
  const listed = new Set(spec.fields.map((f) => f.input));
  const rest = module.inputs.filter((i) => !listed.has(i.name));
  const promoted = rest.filter((i) => i.required).map((i) => everyInput(i, undefined));
  const section = `All ${module.inputs.length} inputs of ${spec.source}`;
  const everything = rest.filter((i) => !i.required).map((i) => everyInput(i, section));

  const inputs = [...headline, ...promoted, ...everything];

  const provider = providerFor(target);

  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    inputs,
    group: spec.group,
    // What this emits is a call to one module. `emits` is documented as
    // resource *or module* names, and recording the source here is what lets
    // the test suite find the catalog entry to check the inputs against
    // without parsing it back out of the label.
    emits: [spec.source],
    build: (values, name): BuildResult => {
      const chosen = new Map<string, unknown>();
      for (const input of inputs) chosen.set(input.id, values[input.id]);

      const header = `# ${spec.label}
#
# Calls ${spec.source} ${versionConstraint(module.version)},
# which is the module's own code — the inputs below were checked against
# version ${module.version} of it, so this plans or it tells you why.

terraform {
  required_version = ">= 1.5"

  # No version pin here: the module declares the provider versions it works
  # with, and a tighter pin in the root (say, a newer major than the module
  # allows) makes terraform init fail to find any release. init records the
  # version it chose in .terraform.lock.hcl; commit that file to hold it.
  required_providers {
    ${provider.localName} = {
      source = "${provider.source}"
    }
  }
}${provider.localName === 'azurerm' ? `

# azurerm will not plan without a features block, even an empty one. The
# subscription comes from ARM_SUBSCRIPTION_ID or the Azure CLI login.
provider "azurerm" {
  features {}
}` : ''}`;

      const call = moduleCall({
        name: spec.name,
        source: spec.source,
        values: chosen,
        tagsInput: spec.tagsInput,
        tags: new Map([
          ['ManagedBy', 'terraform'],
          ['System', String(name || spec.id)],
        ]),
      });

      const outputs = (spec.outputs ?? [])
        .map(
          (output) =>
            `output "${output}" {\n  description = "From ${spec.source}."\n  value       = module.${spec.name}.${output}\n}`,
        )
        .join('\n\n');

      const builds = planModule(spec.source, Object.fromEntries(chosen))
        .filter((r) => r.kind === 'resource')
        .map(({ address, status, because, condition }) => ({ address, status, because, condition }));

      return {
        files: {
          'main.tf': [header, call, outputs].filter(Boolean).join('\n\n') + '\n',
        },
        builds,
      };
    },
  };
}

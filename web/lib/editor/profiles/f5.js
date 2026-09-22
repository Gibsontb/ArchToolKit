/**
 * F5 BIG-IP declarations: AS3 (application services) and Declarative
 * Onboarding (DO).
 *
 * Both are trees of objects with a `class`. What each class may hold comes
 * from F5's published JSON schemas, extracted by tools/fetch-editor-schemas.mjs
 * into f5-schema-data.ts: the property names, the required ones, and every
 * fixed answer set. So `class` is a dropdown of the real classes, and
 * `loadBalancingMode` a dropdown of the modes the schema allows.
 *
 * The checks are the schema's own — an unknown class, a missing required
 * property, a value outside its set — plus the one the schema cannot make:
 * every `use` pointer (and a pool or TLS profile named by string) must name
 * an object the declaration declares.
 */

import { error, info, warning,              } from '../../core/findings.js';
import { F5_SCHEMAS,               } from '../f5-schema-data.js';
import { pathPattern, pathString,                      } from '../doc.js';
import { didYouMean, isObj, last, str,              } from '../profile.js';

/** Classes whose other keys are the names of the objects they contain. */
const CONTAINERS = new Set(['ADC', 'Tenant', 'Application', 'Device', 'DO', 'AS3']);

/** Properties that name another object in the declaration when given as a string. */
const STRING_POINTERS = new Set(['pool', 'serverTLS', 'clientTLS']);

function schemaSource(s          )         {
  return `F5 schema ${s.version} (${s.source})`;
}

/** The declaration inside an AS3 or DO request wrapper, and where it sits. */
function declarationOf(doc      , root                  )                                                           {
  if (!isObj(doc)) return undefined;
  if (doc.class === root) return { decl: doc, at: [] };
  if (isObj(doc.declaration) && doc.declaration.class === root) return { decl: doc.declaration, at: ['declaration'] };
  return undefined;
}

/**
 * The class of the nearest object at or above `path` that has one, and the
 * path pattern from it down: `members[].servicePort` under a Pool.
 */
function classContext(doc      , path      )                                         {
  let node                   = doc;
  let found                                         ;
  if (isObj(node) && typeof node.class === 'string') found = { cls: node.class, at: 0 };
  for (let i = 0; i < path.length; i += 1) {
    if (node === null || node === undefined || typeof node !== 'object') break;
    node = Array.isArray(node) ? node[path[i]          ] : (node                        )[path[i]          ];
    // The field being asked about is `class` itself when i is the last step; that is the object's own class.
    if (i < path.length - 1 && isObj(node) && typeof node.class === 'string') found = { cls: node.class, at: i + 1 };
  }
  return found ? { cls: found.cls, rel: path.slice(found.at) } : undefined;
}

/** Whether dotted version a is later than b. */
function newer(a        , b        )          {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

function makeProfile(family              )          {
  const schema = F5_SCHEMAS[family];
  const classNames = Object.keys(schema.classes).sort();
  const root = family === 'as3' ? 'ADC' : 'Device';
  const wrapper = family === 'as3' ? 'AS3' : 'DO';

  return {
    id: `f5-${family}`,
    family: 'f5',
    label: family === 'as3' ? 'F5 AS3 declaration' : 'F5 Declarative Onboarding declaration',
    format: 'json',
    source: schemaSource(schema),
    detect(doc) {
      if (!isObj(doc)) return 0;
      if (doc.class === root || doc.class === wrapper) return 0.97;
      return isObj(doc.declaration) && doc.declaration.class === root ? 0.97 : 0;
    },
    choices(path, doc) {
      if (last(path) === 'class') return classNames;
      const ctx = classContext(doc, path);
      if (!ctx) return undefined;
      const c = schema.classes[ctx.cls];
      return c?.e[pathPattern(ctx.rel)];
    },
    validate(doc) {
      const out            = [];
      const found = declarationOf(doc, root);
      if (isObj(doc) && doc.class === wrapper && !found) {
        out.push(error(`f5.${family}.declaration`, `An ${wrapper} request needs a declaration of class ${root}.`, { path: 'declaration', source: schemaSource(schema) }));
      }
      if (!isObj(doc)) return out;
      const src = schemaSource(schema);

      // Every declared object, by its full path, for the pointer check.
      const declared = new Set        ();
      if (family === 'as3' && found) {
        for (const [tenant, t] of Object.entries(found.decl)) {
          if (!isObj(t) || t.class !== 'Tenant') continue;
          for (const [app, a] of Object.entries(t)) {
            if (!isObj(a) || a.class !== 'Application') continue;
            for (const [name, o] of Object.entries(a)) if (isObj(o) && 'class' in o) declared.add(`/${tenant}/${app}/${name}`);
          }
        }
      }

      const walk = (node      , path                     , cls                    , rel                     , where                                   )       => {
        if (Array.isArray(node)) {
          node.forEach((v, i) => walk(v, [...path, i], cls, [...rel, i], where));
          return;
        }
        if (!isObj(node)) {
          if (typeof node === 'string' && cls) {
            const allowed = schema.classes[cls]?.e[pathPattern(rel)];
            if (allowed && allowed.length && !allowed.includes(node) && !/^\d+\.\d+\.\d+$/.test(node)) {
              const guess = didYouMean(node, allowed);
              out.push(error(`f5.${family}.value`, `“${node}” is not an allowed ${String(last(rel))} for ${cls}.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString(path), source: src }));
            }
            const prop = rel.filter((r) => typeof r === 'string').pop();
            if (family === 'as3' && prop && STRING_POINTERS.has(prop) && rel.length === 1 && where.tenant && where.app) {
              checkPointer(node, path, where);
            }
          }
          return;
        }
        // A pointer to another declared object.
        if (family === 'as3' && typeof node.use === 'string' && Object.keys(node).length === 1) {
          checkPointer(node.use, [...path, 'use'], where);
          return;
        }
        const own = str(node.class);
        if (own !== undefined) {
          const c = schema.classes[own];
          if (!c) {
            const guess = didYouMean(own, classNames);
            out.push(error(`f5.${family}.class`, `${own} is not a${family === 'as3' ? 'n AS3' : ' DO'} class.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString([...path, 'class']), source: src }));
          } else {
            for (const r of c.r) {
              if (!(r in node)) out.push(error(`f5.${family}.required`, `${own} needs ${r}.`, { path: pathString(path), source: src }));
            }
            const container = CONTAINERS.has(own);
            const props = new Set(c.p);
            for (const [k, v] of Object.entries(node)) {
              if (k === 'class' || props.has(k)) continue;
              if (container && isObj(v)) continue;
              const guess = didYouMean(k, c.p);
              out.push(
                (container ? warning : error)(`f5.${family}.property`, `${own} has no property ${k}.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString([...path, k]), source: src }),
              );
            }
          }
          const next = { ...where };
          if (own === 'Tenant') next.tenant = String(last(path));
          if (own === 'Application') next.app = String(last(path));
          for (const [k, v] of Object.entries(node)) if (k !== 'class') walk(v, [...path, k], own, [k], next);
          return;
        }
        for (const [k, v] of Object.entries(node)) walk(v, [...path, k], cls, [...rel, k], where);
      };

      const checkPointer = (target        , path                     , where                                   )       => {
        const full = target.startsWith('/')
          ? target
          : target.includes('/')
            ? `/${where.tenant}/${target}`
            : `/${where.tenant}/${where.app}/${target}`;
        if (declared.has(full)) return;
        // /Common/Shared objects may be declared in this or an earlier declaration.
        if (full.startsWith('/Common/Shared/')) {
          if (!declared.has(full)) out.push(info(`f5.as3.pointer-shared`, `${target} is not in this declaration; it must already be declared in /Common/Shared.`, { path: pathString(path) }));
          return;
        }
        const names = [...declared].filter((d) => d.startsWith(`/${where.tenant}/${where.app}/`)).map((d) => d.split('/').pop()          );
        const guess = didYouMean(target.split('/').pop()          , names);
        out.push(error('f5.as3.pointer', `${target} points at nothing this declaration declares.${guess ? ` Did you mean ${guess}?` : ''}`, { path: pathString(path), remediation: 'Declare it in the application, or point at an existing BIG-IP object with {"bigip": "/Common/…"}.' }));
      };

      walk(doc, [], undefined, [], {});

      const version = found ? str(found.decl.schemaVersion) : undefined;
      if (version && /^\d+\.\d+\.\d+$/.test(version) && newer(version, schema.version)) {
        out.push(
          info(`f5.${family}.schemaVersion`, `schemaVersion ${version} is newer than the schema the toolkit checks against (${schema.version}); properties added since then show as unknown.`, {
            path: pathString([...(found?.at ?? []), 'schemaVersion']),
            remediation: 'Run npm run editor:update to fetch the current schema.',
          }),
        );
      }
      return out;
    },
    itemTitle(value) {
      if (!isObj(value)) return typeof value === 'string' ? value : undefined;
      const addrs = Array.isArray(value.serverAddresses) ? value.serverAddresses.join(', ') : undefined;
      return str(value.class) ?? (addrs ? `${addrs}${value.servicePort !== undefined ? `:${value.servicePort}` : ''}` : undefined) ?? str(value.name);
    },
  };
}

export const f5As3 = makeProfile('as3');
export const f5Do = makeProfile('do');

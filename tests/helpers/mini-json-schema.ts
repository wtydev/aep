/**
 * Minimal JSON Schema (draft 2020-12 subset) validator for tests.
 * Supports exactly the keywords used by tests/fixtures/mep-core/core.schema.json:
 *   $ref (#/$defs/...), type, properties, required, additionalProperties (bool|schema),
 *   items (schema|array), enum, const, pattern, minLength, maxLength,
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum, oneOf, anyOf, allOf, not,
 *   if/then/else, $defs. `format` and annotation keywords are ignored.
 */

export type JsonSchema = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => deepEqual(v, b[i]))
    );
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
};

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v;

function typeMatches(type: string, v: unknown): boolean {
  switch (type) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'object':
      return isObject(v);
    case 'array':
      return Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return typeof v === type;
  }
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  let node: unknown = root;
  for (const seg of ref.slice(2).split('/')) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    node = isObject(node) ? node[key] : undefined;
  }
  if (!isObject(node)) throw new Error(`unresolvable $ref: ${ref}`);
  return node;
}

function validateNode(
  schema: unknown,
  data: unknown,
  root: JsonSchema,
  path: string,
  errors: string[],
): void {
  if (typeof schema === 'boolean') {
    if (!schema) errors.push(`${path}: schema is false`);
    return;
  }
  if (!isObject(schema)) return;

  if (typeof schema.$ref === 'string') {
    validateNode(resolveRef(schema.$ref, root), data, root, path, errors);
    // 2020-12: $ref composes with sibling keywords; apply them too.
    const { $ref: _ignored, ...rest } = schema;
    if (Object.keys(rest).length > 0) validateNode(rest, data, root, path, errors);
    return;
  }

  const fail = (msg: string) => errors.push(`${path}: ${msg}`);

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (typeof types[0] === 'string' && !types.some((t) => typeMatches(t as string, data)))
      fail(`expected type ${types.join('|')}, got ${typeOf(data)}`);
  }

  if ('const' in schema && !deepEqual(schema.const, data))
    fail(`expected const ${JSON.stringify(schema.const)}`);

  if (Array.isArray(schema.enum) && !schema.enum.some((v) => deepEqual(v, data)))
    fail(`expected one of ${JSON.stringify(schema.enum)}`);

  if (typeof data === 'string') {
    const len = [...data].length;
    if (typeof schema.minLength === 'number' && len < schema.minLength)
      fail(`minLength ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && len > schema.maxLength)
      fail(`maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(data))
      fail(`pattern ${schema.pattern}`);
  }

  if (typeof data === 'number') {
    if (typeof schema.minimum === 'number' && data < schema.minimum)
      fail(`minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && data > schema.maximum)
      fail(`maximum ${schema.maximum}`);
    if (
      schema.exclusiveMinimum === true &&
      typeof schema.minimum === 'number' &&
      data <= schema.minimum
    )
      fail(`exclusiveMinimum ${schema.minimum}`);
    if (typeof schema.exclusiveMinimum === 'number' && data <= schema.exclusiveMinimum)
      fail(`exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (
      schema.exclusiveMaximum === true &&
      typeof schema.maximum === 'number' &&
      data >= schema.maximum
    )
      fail(`exclusiveMaximum ${schema.maximum}`);
    if (typeof schema.exclusiveMaximum === 'number' && data >= schema.exclusiveMaximum)
      fail(`exclusiveMaximum ${schema.exclusiveMaximum}`);
  }

  if (isObject(data)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !(key in data)) fail(`missing required property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in data) validateNode(sub, data[key], root, `${path}.${key}`, errors);
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(data)) {
        if (key in props) continue;
        if (schema.additionalProperties === false) fail(`additional property "${key}" not allowed`);
        else if (
          isObject(schema.additionalProperties) ||
          typeof schema.additionalProperties === 'boolean'
        )
          validateNode(schema.additionalProperties, data[key], root, `${path}.${key}`, errors);
      }
    }
  }

  if (Array.isArray(data)) {
    if (schema.items !== undefined) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((sub, i) => {
          if (i < data.length) validateNode(sub, data[i], root, `${path}[${i}]`, errors);
        });
        const rest = schema.additionalItems;
        if (isObject(rest) || typeof rest === 'boolean') {
          for (let i = schema.items.length; i < data.length; i++)
            validateNode(rest, data[i], root, `${path}[${i}]`, errors);
        }
      } else {
        data.forEach((item, i) => validateNode(schema.items, item, root, `${path}[${i}]`, errors));
      }
    }
  }

  for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
    const subs = schema[combiner];
    if (!Array.isArray(subs)) continue;
    const results = subs.map((sub) => {
      const errs: string[] = [];
      validateNode(sub, data, root, path, errs);
      return errs;
    });
    if (combiner === 'allOf') results.flat().forEach((e) => errors.push(e));
    else if (combiner === 'anyOf' && results.every((r) => r.length > 0))
      fail(`matches none of the ${subs.length} anyOf schemas`);
    else if (combiner === 'oneOf') {
      const ok = results.filter((r) => r.length === 0).length;
      if (ok !== 1) fail(`matches ${ok} of the ${subs.length} oneOf schemas (expected exactly 1)`);
    }
  }

  if (schema.not !== undefined) {
    const errs: string[] = [];
    validateNode(schema.not, data, root, path, errs);
    if (errs.length === 0) fail('matches "not" schema');
  }

  if (schema.if !== undefined) {
    const cond: string[] = [];
    validateNode(schema.if, data, root, path, cond);
    const branch = cond.length === 0 ? schema.then : schema.else;
    if (branch !== undefined) validateNode(branch, data, root, path, errors);
  }
}

/** Validate `data` against `schema`; returns a list of human-readable errors (empty = valid). */
export function validate(schema: JsonSchema, data: unknown): string[] {
  const errors: string[] = [];
  validateNode(schema, data, schema, '$', errors);
  return errors;
}

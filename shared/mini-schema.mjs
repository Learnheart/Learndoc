// Tiny JSON-schema subset validator for widget props. Isomorphic: no node: imports.
// Supported: type, properties, required, additionalProperties, items, enum, minimum, maximum,
// minItems, maxItems, minLength, maxLength. Other keywords are ignored.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === type;
}

const pointer = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

// -> [{ path, keyword, message }]; empty when valid. `path` is a JSON pointer into `value`.
export function validate(schema, value, path = '') {
  const errors = [];
  const fail = (keyword, message, at = path) => errors.push({ path: at || '/', keyword, message });

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      fail('type', `must be ${types.join(' or ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    fail('enum', `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('minimum', `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail('maximum', `must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail('minLength', `must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail('maxLength', `must have at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('minItems', `must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('maxItems', `must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, pointer(path, i))));
  }
  if (typeOf(value) === 'object') {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) fail('required', `missing required property "${key}"`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        errors.push(...validate(properties[key], item, pointer(path, key)));
      } else if (schema.additionalProperties === false) {
        fail('additionalProperties', `unknown property "${key}"`, pointer(path, key));
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, item, pointer(path, key)));
      }
    }
  }
  return errors;
}

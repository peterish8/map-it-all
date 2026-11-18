// Runtime checks for the JSON Schema subset the MCP tools declare: type, enum, required, minimum, maximum,
// properties and items.type. Everything else in a schema (descriptions, defaults) is documentation only.
//
// Compatibility rules (decision D-06): unknown properties are ignored, and `null` counts as absent, because
// clients often send null for optional fields. Wrong types, out-of-range numbers, values outside an enum and
// missing required fields are reported with a path, so the caller can name the field.
//
// The same validator is meant for other structured input later (review findings, trusted-check config).

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

const TYPE_NAMES = {
  string: 'a string', integer: 'an integer', number: 'a number', boolean: 'a boolean', array: 'an array', object: 'an object',
};

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const join = (at, key) => (at ? `${at}.${key}` : key);
const absent = (v) => v === undefined || v === null;

/** Returns [{ path, message }]; an empty list means the value conforms. `path` is '' for the value itself. */
export function validate(schema, value, at = '') {
  const problems = [];
  check(schema, value, at, problems);
  return problems;
}

function check(schema, value, at, problems) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && TYPE_CHECKS[schema.type] && !TYPE_CHECKS[schema.type](value)) {
    problems.push({ path: at, message: `must be ${TYPE_NAMES[schema.type]} (got ${kindOf(value)})` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push({ path: at, message: `must be one of ${schema.enum.join(', ')}` });
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push({ path: at, message: `must be at least ${schema.minimum} (got ${value})` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push({ path: at, message: `must be at most ${schema.maximum} (got ${value})` });
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => { if (!absent(item)) check(schema.items, item, `${at}[${i}]`, problems); });
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (absent(value[key])) problems.push({ path: join(at, key), message: 'is required' });
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (!absent(value[key])) check(sub, value[key], join(at, key), problems);
    }
  }
}

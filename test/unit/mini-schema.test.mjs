import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from '../../shared/mini-schema.mjs';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['n', 'items'],
  properties: {
    n: { type: 'integer', minimum: 1, maximum: 5 },
    name: { type: 'string', minLength: 2, maxLength: 4 },
    mode: { enum: ['a', 'b'] },
    either: { type: ['number', 'null'] },
    items: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: { type: 'boolean' } } },
  },
};

test('valid value has no errors', () => {
  assert.deepEqual(validate(schema, { n: 3, name: 'abc', mode: 'a', either: null, items: [{ x: 1, flag: true }] }), []);
});

test('reports each keyword with a JSON pointer path', () => {
  const errors = validate(schema, { n: 1.5, name: 'a', mode: 'c', either: 'x', items: [], extra: 1 });
  assert.deepEqual(errors.map((e) => `${e.keyword} ${e.path}`).sort(), [
    'additionalProperties /extra', 'enum /mode', 'minItems /items', 'minLength /name', 'type /either', 'type /n',
  ]);
});

test('minimum, maximum, maxLength, maxItems, required, nested additionalProperties schema', () => {
  const errors = validate(schema, { n: 9, name: 'abcde', items: [{ x: 'no', flag: 1 }, {}, {}] });
  assert.deepEqual(errors.map((e) => `${e.keyword} ${e.path}`).sort(), [
    'maxItems /items', 'maxLength /name', 'maximum /n', 'type /items/0/flag', 'type /items/0/x',
  ]);
  assert.deepEqual(validate(schema, {}).map((e) => e.message), ['missing required property "n"', 'missing required property "items"']);
  assert.equal(validate({ type: 'integer', minimum: 0 }, -1)[0].keyword, 'minimum');
  assert.equal(validate({ type: 'number' }, Number.NaN)[0].keyword, 'type');
  assert.equal(validate({ type: 'string', maxLength: 1 }, '😀').length, 0, 'length counts code points');
});

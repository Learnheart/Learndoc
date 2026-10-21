import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as validators from '../../lib/generated-validators.mjs';
import { SKILL } from './helpers.mjs';

const schema = (name) => JSON.parse(fs.readFileSync(path.join(SKILL, 'schemas', `${name}.schema.json`), 'utf8'));
const BLOCK_TYPES = ['heading', 'prose', 'box', 'math', 'code', 'figure', 'widget', 'quiz'];

test('generated validators export one function per schema plus the single-block validator', () => {
  for (const name of ['config', 'course', 'lesson', 'changeset', 'answer', 'block']) assert.equal(typeof validators[name], 'function', name);
});

test('changeset block definitions equal the lesson block definitions without id', () => {
  const lesson = schema('lesson').$defs;
  const changeset = schema('changeset').$defs;
  for (const type of BLOCK_TYPES) {
    const expected = structuredClone(lesson[type]);
    delete expected.properties.id;
    expected.required = expected.required.filter((key) => key !== 'id');
    assert.deepEqual(changeset[type], expected, type);
  }
});

test('changeset schema avoids Ajv-only keywords so it can be passed to --json-schema', () => {
  assert.doesNotMatch(JSON.stringify(schema('changeset')), /discriminator/);
  assert.equal(validators.changeset({ summary: 'x', changes: [{ op: 'insert', after: null, role: 'related', reason: 'r', block: { type: 'heading', level: 2, anchor: 'a', text: 't' } }] }), true);
  assert.equal(validators.changeset({ changes: [{ op: 'replace', role: 'primary', block: { id: 'b-0001', type: 'heading', level: 2, anchor: 'a', text: 't' } }] }), false, 'blocks in a changeset never carry id');
  assert.equal(validators.changeset({ needsConfirmation: { scope: ['b-0001'], reason: 'wide' } }), true);
});

test('schemas passed verbatim to claude --json-schema carry no $schema', () => {
  for (const name of ['changeset', 'answer']) assert.equal(Object.hasOwn(schema(name), '$schema'), false, name);
});

test('editModel accepts model names and aliases only', () => {
  for (const editModel of ['sonnet', 'claude-sonnet-4-5', 'opus[1m]', 'claude-3.5-haiku']) {
    assert.equal(validators.config({ schemaVersion: 1, language: 'en', editModel }), true, editModel);
  }
  for (const editModel of ['', '--dangerous', 'a b', 'x;rm']) {
    assert.equal(validators.config({ schemaVersion: 1, language: 'en', editModel }), false, editModel);
  }
});

test('html whitelist matches the contract', () => {
  const whitelist = JSON.parse(fs.readFileSync(path.join(SKILL, 'schemas', 'html-whitelist.json'), 'utf8'));
  assert.deepEqual(Object.keys(whitelist.html.tags).sort(), ['a', 'b', 'blockquote', 'br', 'code', 'em', 'i', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
  assert.deepEqual(whitelist.html.classes, ['term', 'muted', 'takeaways', 'refs', 'symbols', 'data']);
  assert.deepEqual(Object.entries(whitelist.svg.tags).filter(([, attrs]) => attrs.includes('id')).map(([tag]) => tag), ['marker', 'clipPath']);
});

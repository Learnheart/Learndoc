import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { crc32, zip } from '../../lib/zip.mjs';
import { unzip } from './helpers.mjs';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('zip round-trips entries, deflating only when it helps', () => {
  const text = Buffer.from('learndoc '.repeat(500));
  const random = crypto.randomBytes(2048);
  const entries = unzip(zip([{ name: '01-intro.pdf', data: text }, { name: 'bài-02.pdf', data: random }]));
  assert.deepEqual(entries.map((e) => [e.name, e.method]), [['01-intro.pdf', 8], ['bài-02.pdf', 0]]);
  assert.ok(entries[0].data.equals(text));
  assert.ok(entries[1].data.equals(random));
  assert.deepEqual(unzip(zip([])), []);
});

// Test helpers: fixture project copies in temp dirs, reading back a .zip.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { formatJson } from '../../lib/project.mjs';
import { crc32 } from '../../lib/zip.mjs';

export const FIXTURE = fileURLToPath(new URL('../fixtures/project', import.meta.url));
export const SKILL = fileURLToPath(new URL('../..', import.meta.url));

// Copies the fixture project into a fresh temp dir (outside any git work tree). -> root path
export function copyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learndoc-test-'));
  fs.cpSync(FIXTURE, root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const writeJson = (file, value) => fs.writeFileSync(file, formatJson(value));

export const fixtureJson = (relative) => readJson(path.join(FIXTURE, relative));

export const codes = (diagnostics) => diagnostics.map((entry) => entry.code);

// Git identity for commits made in tests.
export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'learndoc-test',
  GIT_AUTHOR_EMAIL: 'test@learndoc.invalid',
  GIT_COMMITTER_NAME: 'learndoc-test',
  GIT_COMMITTER_EMAIL: 'test@learndoc.invalid',
};

// Reads an archive back through its central directory. -> [{ name, method, data }]
export function unzip(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  assert.equal(at + archive.readUInt32LE(end + 12), end, 'central directory sits right before its end record');
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    assert.equal(archive.readUInt16LE(local + 6) & 0x0800, 0x0800, 'UTF-8 name flag');
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const body = archive.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), crc, `${name} crc`);
    entries.push({ name, method, data });
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return entries;
}

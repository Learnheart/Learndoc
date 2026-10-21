// Test helpers: fixture project copies in temp dirs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatJson } from '../../lib/project.mjs';

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

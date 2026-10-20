/**
 * Implementation tests for the single-Zod guard's lockfile reader.
 *
 * The specification oracle in `check-single-zod.spec.test.ts` pins the rule;
 * these tests cover the pnpm lockfile shapes that a real lockfile can contain:
 * peer-resolved keys, the legacy `/`-prefixed key form, entries that exist only
 * in the snapshots section, metadata lines that must never be mistaken for
 * package keys, and lockfiles whose layout cannot be recognized at all.
 *
 * @module check-single-zod.impl
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ZOD_VERSION, checkSingleZod } from './check-single-zod.js';

/** Temporary directories created by a test, removed after the test. */
const temporaryDirectories: string[] = [];

/**
 * Creates an empty temporary repository root.
 *
 * @returns The absolute path of the new directory.
 */
function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'single-zod-impl-'));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Writes a `pnpm-lock.yaml` fixture and returns its root.
 *
 * @param content - The lockfile text.
 * @returns The absolute path of the fixture root.
 */
function rootWithLockfile(content: string): string {
  const root = temporaryRoot();
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), content, 'utf-8');
  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('Single-Zod guard lockfile reader', () => {
  it('should read a peer-resolved Zod key', () => {
    const root = rootWithLockfile(
      `lockfileVersion: '9.0'\n\npackages:\n\n  zod@${ZOD_VERSION}(peer@1.0.0):\n    resolution: {integrity: sha512-fixture}\n`
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(true);
    expect(result.versions).toEqual([ZOD_VERSION]);
  });

  it('should read the legacy slash-prefixed key form', () => {
    const root = rootWithLockfile(
      `lockfileVersion: '6.0'\n\npackages:\n\n  /zod@${ZOD_VERSION}:\n    resolution: {integrity: sha512-fixture}\n`
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(true);
    expect(result.versions).toEqual([ZOD_VERSION]);
  });

  it('should read a Zod entry that exists only in the snapshots section', () => {
    const root = rootWithLockfile(
      `lockfileVersion: '9.0'\n\npackages:\n\n  react@19.2.8:\n    resolution: {integrity: sha512-fixture}\n\nsnapshots:\n\n  zod@${ZOD_VERSION}: {}\n`
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(true);
    expect(result.versions).toEqual([ZOD_VERSION]);
  });

  it('should not mistake metadata lines for package keys', () => {
    const root = rootWithLockfile(
      `lockfileVersion: '9.0'\n\npackages:\n\n  react@19.2.8:\n    resolution: {integrity: sha512-fixture}\n    engines: {node: '>=18'}\n`
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(result.versions).toEqual([]);
    expect(
      result.violations.some(violation => violation.message.includes('resolves no zod package'))
    ).toBe(true);
  });

  it('should fail loudly on a lockfile without a packages section', () => {
    const root = rootWithLockfile("lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n");

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(
      result.violations.some(violation => violation.message.includes('no packages section'))
    ).toBe(true);
  });

  it('should fail loudly on a foreign lockfile layout', () => {
    const root = rootWithLockfile('# yarn lockfile v1\n\nzod@^4.4.3:\n  version "4.4.3"\n');

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(
      result.violations.some(violation => violation.message.includes('layout is not recognized'))
    ).toBe(true);
  });
});

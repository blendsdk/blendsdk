/**
 * Specification tests for the single-Zod guard.
 *
 * The repository standard is one Zod version and one copy of it. Zod is a
 * security-sensitive parser, so a second copy or a stale range could silently
 * diverge from the version whose native `z.toJSONSchema` the OpenAPI tooling
 * relies on. These tests pin two rules:
 *
 * - `yarn.lock` resolves Zod exactly once, at the supported version.
 * - Neither the runtime client package nor a generated client depends on Zod.
 *
 * The guard is exercised against the real repository and against small
 * fixtures that contain a deliberate violation, so the tests fail when the
 * guard stops detecting each rule.
 *
 * @module check-single-zod.spec
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ZOD_VERSION, checkSingleZod } from './check-single-zod.js';

/** The repository root, one level above `scripts/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Temporary directories created by a test, removed after the test. */
const temporaryDirectories: string[] = [];

/**
 * Creates an empty temporary repository root.
 *
 * @returns The absolute path of the new directory.
 */
function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'single-zod-'));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Writes a file, creating parent directories.
 *
 * @param root - The repository root.
 * @param relativePath - The path relative to the root.
 * @param content - The file content.
 */
function writeFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
}

/**
 * Writes a valid single-Zod baseline into a fixture root.
 *
 * @param root - The repository root.
 */
function writeCleanFixture(root: string): void {
  writeFile(
    root,
    'yarn.lock',
    `zod@^${ZOD_VERSION}:\n  version "${ZOD_VERSION}"\n  resolved "https://registry.yarnpkg.com/zod/-/zod-${ZOD_VERSION}.tgz"\n`
  );
  writeFile(
    root,
    'packages/api-client/package.json',
    JSON.stringify({ name: '@blendsdk/api-client', version: '1.0.0' }, null, 2)
  );
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('Single-Zod guard', () => {
  it('should accept the repository as clean', () => {
    const result = checkSingleZod(REPO_ROOT);

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('should report exactly the supported resolved version', () => {
    const result = checkSingleZod(REPO_ROOT);

    expect(result.versions).toEqual([ZOD_VERSION]);
  });

  it('should accept a fixture that resolves Zod once', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);

    expect(checkSingleZod(root).violations).toEqual([]);
  });

  it('should reject a second Zod resolution', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    writeFile(
      root,
      'yarn.lock',
      `zod@^${ZOD_VERSION}:\n  version "${ZOD_VERSION}"\n\nzod@^3.23.0:\n  version "3.23.0"\n`
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('should reject a nested Zod copy', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    writeFile(root, 'packages/api-client/node_modules/zod/package.json', '{}');

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(result.violations.some(violation => violation.message.includes('nested'))).toBe(true);
  });

  it('should reject a runtime package that depends on Zod', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    writeFile(
      root,
      'packages/api-client/package.json',
      JSON.stringify({ name: '@blendsdk/api-client', dependencies: { zod: `^${ZOD_VERSION}` } })
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(result.violations.some(violation => violation.message.includes('api-client'))).toBe(
      true
    );
  });

  it('should reject a generated client that imports Zod', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    writeFile(
      root,
      'packages/playground/src/api-client/types.ts',
      "import { z } from 'zod';\n\nexport type X = string;\n"
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it('should reject the wrong resolved version', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    writeFile(root, 'yarn.lock', 'zod@^4.0.0:\n  version "4.0.0"\n');

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(result.violations.some(violation => violation.message.includes('expected 4.4.3'))).toBe(
      true
    );
  });

  it('should reject a Zod subpath import', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    writeFile(
      root,
      'packages/webafx/src/schema.ts',
      "import { z } from 'zod/v3';\n\nexport const schema = z.string();\n"
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(result.violations.some(violation => violation.message.includes('subpath'))).toBe(true);
  });

  it('should accept a multi-range block that resolves one version', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    writeFile(root, 'yarn.lock', `zod@^${ZOD_VERSION}, zod@^4.0.0:\n  version "${ZOD_VERSION}"\n`);

    expect(checkSingleZod(root).violations).toEqual([]);
  });

  it('should count a quoted descriptor with whitespace as a second resolution', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    writeFile(
      root,
      'yarn.lock',
      `zod@^${ZOD_VERSION}:\n  version "${ZOD_VERSION}"\n\n"zod@>=3.0.0 <4.0.0":\n  version "3.25.0"\n`
    );

    const result = checkSingleZod(root);

    expect(result.ok).toBe(false);
    expect(result.versions).toEqual(['3.25.0', ZOD_VERSION]);
  });

  it('should not follow a symlinked source file', () => {
    const root = temporaryRoot();
    writeCleanFixture(root);
    const outside = path.join(root, 'outside.ts');
    fs.writeFileSync(outside, "import { z } from 'zod/v3';\n");
    const sourceDirectory = path.join(root, 'packages', 'webafx', 'src');
    fs.mkdirSync(sourceDirectory, { recursive: true });
    fs.symlinkSync(outside, path.join(sourceDirectory, 'linked.ts'));

    expect(checkSingleZod(root).violations).toEqual([]);
  });
});
